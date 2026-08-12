// Low-stock classification.
//
// Scope: this file answers one question — given a product's current
// quantity and its low-stock configuration, is it Normal, Low Stock, or
// Out of Stock (PRD §22)? It does NOT:
//   - read Product, IndexedDB, or anything else — pure function over
//     plain numbers/booleans already in hand
//   - decide the global default threshold's VALUE (that's
//     shared/constants.js's DEFAULT_LOW_STOCK_THRESHOLD) — this file just
//     consumes whatever default it's given
//   - render any warning UI or badge — that's a component's job, driven
//     by this function's output
//
// THRESHOLD RESOLUTION (PRD §22): a product's effective low-stock
// threshold is its own override if set, otherwise the global default —
// the same "override wins, else fall back to global" pattern already
// established for margin (marginCalculations.js's resolveMargin). This
// file provides its own resolver rather than importing resolveMargin,
// because the two thresholds are conceptually unrelated even though the
// resolution SHAPE happens to be identical; keeping them as separate,
// independently-named functions avoids implying a coupling between margin
// and stock-level configuration that doesn't actually exist.
//
// DISABLING THE WARNING (PRD §22: "a product may also disable low-stock
// warnings"): when disabled, a product is NEVER classified as "Low Stock"
// regardless of quantity — but it can still be "Out of Stock" at exactly
// zero. Disabling the low-stock WARNING is not the same as disabling the
// concept of being out of stock entirely; a shop owner who has muted the
// low-stock nudge for a slow-moving item still needs to see "Out of
// Stock" when there's genuinely nothing left, since that's a different,
// more absolute fact than "running low."

export const STOCK_STATUS = Object.freeze({
  NORMAL: 'Normal',
  LOW: 'Low Stock',
  OUT: 'Out of Stock'
});

/**
 * Resolve the effective low-stock threshold for a product: its own
 * override if one is set, otherwise the shop-wide default.
 *
 * @param {number} globalDefaultThreshold The shop-wide default threshold.
 *   Must be a finite number >= 0.
 * @param {number|null|undefined} productThresholdOverride The product's
 *   own override, or null/undefined to mean "use the global default"
 *   (Product.lowStockThreshold).
 * @returns {number} The threshold to use for this product.
 */
export function resolveLowStockThreshold(globalDefaultThreshold, productThresholdOverride) {
  if (
    typeof globalDefaultThreshold !== 'number' ||
    !Number.isFinite(globalDefaultThreshold) ||
    globalDefaultThreshold < 0
  ) {
    throw new TypeError(
      'resolveLowStockThreshold requires a finite, non-negative globalDefaultThreshold.'
    );
  }
  const hasOverride =
    typeof productThresholdOverride === 'number' &&
    Number.isFinite(productThresholdOverride) &&
    productThresholdOverride >= 0;
  return hasOverride ? productThresholdOverride : globalDefaultThreshold;
}

/**
 * Classify a product's current stock level.
 *
 * Rules (PRD §22):
 *   - quantity <= 0                        -> OUT (always, even if
 *                                              low-stock warnings are
 *                                              disabled for this product)
 *   - lowStockDisabled === true             -> NORMAL (unless already OUT)
 *   - 0 < quantity <= effectiveThreshold    -> LOW
 *   - quantity > effectiveThreshold         -> NORMAL
 *
 * @param {object} input
 * @param {number} input.quantity Current materialized quantity. Must be a
 *   finite number >= 0 (matches the invariant productValidation.js/
 *   applyStockEvent.js already maintain on Product.quantity).
 * @param {number} input.globalDefaultThreshold Shop-wide default
 *   low-stock threshold.
 * @param {number|null} [input.productThresholdOverride] The product's own
 *   threshold override, or null/omitted to use the global default.
 * @param {boolean} [input.lowStockDisabled] If true, this product is never
 *   classified as LOW — but can still be OUT at zero quantity.
 * @returns {'Normal'|'Low Stock'|'Out of Stock'}
 */
export function classifyStockStatus({
  quantity,
  globalDefaultThreshold,
  productThresholdOverride,
  lowStockDisabled = false
}) {
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity < 0) {
    throw new TypeError('classifyStockStatus requires a finite, non-negative quantity.');
  }

  if (quantity <= 0) {
    // Out of stock is absolute — it is not suppressed by
    // lowStockDisabled. "I've muted the low-stock nudge for this item"
    // does not mean "tell me nothing is wrong when there is genuinely
    // nothing left."
    return STOCK_STATUS.OUT;
  }

  if (lowStockDisabled) {
    return STOCK_STATUS.NORMAL;
  }

  const effectiveThreshold = resolveLowStockThreshold(
    globalDefaultThreshold,
    productThresholdOverride
  );

  return quantity <= effectiveThreshold ? STOCK_STATUS.LOW : STOCK_STATUS.NORMAL;
}

/**
 * Convenience boolean: is this product currently at or below its
 * effective low-stock threshold (LOW or OUT)? Useful for dashboard
 * filtering/counting (PRD §28/§29) without needing to compare the status
 * string directly.
 *
 * @param {'Normal'|'Low Stock'|'Out of Stock'} status
 * @returns {boolean}
 */
export function needsAttention(status) {
  return status === STOCK_STATUS.LOW || status === STOCK_STATUS.OUT;
}
