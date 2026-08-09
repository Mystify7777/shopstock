// Margin calculations — pure functions over (cost, sellingPrice, margin)
// numbers already in hand.
//
// Scope, deliberately narrow, mirroring costCalculations.js:
//   - no IndexedDB/MongoDB/Product knowledge
//   - no decision about WHICH cost figure to use (averageKnownCost vs.
//     estimateCostForUnknownStock's estimatedCostPerUnit) — that choice
//     belongs to the caller (a service), which must pass in a plain number
//     and, if using an estimate, is responsible for labelling it as such
//     in the UI. This file only ever sees "a cost," never asks where it
//     came from.
//   - no mutation, no events, no selling-price writes — PRD §19 is explicit
//     that selling price is manually authoritative; this file can SUGGEST
//     a price but never sets one.
//
// TERMINOLOGY — this is the one thing this file exists to get right:
//
//   MARGIN (what this codebase means by "margin," always):
//     margin = (sellingPrice - cost) / sellingPrice × 100
//     — margin as a percentage OF THE SELLING PRICE.
//
//   MARKUP (NOT what this codebase calls margin — never used here):
//     markup = (sellingPrice - cost) / cost × 100
//     — margin as a percentage OF THE COST.
//
//   These are different numbers for the same sale. Cost ₹80, price ₹100:
//     margin  = (100-80)/100 × 100 = 20%
//     markup  = (100-80)/80  × 100 = 25%
//   PRD §20's example (default margin 20%, cost ₹80 → suggested ₹100) only
//   works out if "margin" means gross margin as defined above, so that's
//   the definition this file implements throughout.
//
// Suggested price is solved algebraically from the margin definition:
//     margin = (price - cost) / price
//     margin × price = price - cost
//     cost = price - margin × price = price × (1 - margin)
//     price = cost / (1 - margin)
//
// This blows up at margin = 100% (division by zero) and is meaningless
// above 100% (would require a negative price to hold cost fixed) — both
// handled explicitly below rather than returning Infinity/NaN/a negative
// number and letting a caller display something nonsensical.

/**
 * Resolve the margin percentage that actually applies to a product: its
 * own override if one is set, otherwise the shop-wide default.
 *
 * Mirrors the PRD §20 rule: "the configured margin is a suggestion
 * mechanism, not the authoritative financial state" — this function is
 * only ever used to compute a SUGGESTED price, never to determine the
 * product's real current margin (see calculateActualMargin for that).
 *
 * @param {number} globalDefaultMargin The shop-wide default margin percent.
 * @param {number|null|undefined} productMarginOverride The product's own
 *   override, or null/undefined to mean "use the global default"
 *   (Product.marginOverride — see productValidation.js/productFactory.js).
 * @returns {number} The margin percent to use for this product.
 */
export function resolveMargin(globalDefaultMargin, productMarginOverride) {
  if (typeof globalDefaultMargin !== 'number' || !Number.isFinite(globalDefaultMargin)) {
    throw new TypeError('resolveMargin requires a finite globalDefaultMargin.');
  }
  const hasOverride =
    typeof productMarginOverride === 'number' && Number.isFinite(productMarginOverride);
  return hasOverride ? productMarginOverride : globalDefaultMargin;
}

/**
 * Solve for the selling price implied by a cost and a target gross margin.
 *
 * price = cost / (1 - margin/100)
 *
 * @param {number} cost The cost per unit to base the suggestion on. Caller
 *   decides whether this is averageKnownCost, latestCost, or an
 *   explicitly-labelled estimate — this function doesn't know or care.
 * @param {number} marginPercent Target gross margin, e.g. 20 for 20%.
 * @returns {{ suggestedPrice: number|null, reason: string|null }}
 *   suggestedPrice is null (with `reason` explaining why) when the margin
 *   makes the calculation undefined or meaningless:
 *     - margin === 100  → division by zero, no finite price solves it
 *     - margin > 100    → mathematically requires a negative price to hold
 *                          cost fixed; not meaningful for a suggestion
 *   Negative margins ARE allowed and produce a valid (lower-than-cost)
 *   suggested price — loss-leader pricing is a legitimate deliberate
 *   choice (see productValidation.js, which allows negative
 *   marginOverride for the same reason).
 */
export function calculateSuggestedSellingPrice(cost, marginPercent) {
  if (typeof cost !== 'number' || !Number.isFinite(cost)) {
    throw new TypeError('calculateSuggestedSellingPrice requires a finite cost.');
  }
  if (typeof marginPercent !== 'number' || !Number.isFinite(marginPercent)) {
    throw new TypeError('calculateSuggestedSellingPrice requires a finite marginPercent.');
  }

  if (marginPercent === 100) {
    return {
      suggestedPrice: null,
      reason: 'A 100% margin has no finite suggested price (division by zero).'
    };
  }
  if (marginPercent > 100) {
    return {
      suggestedPrice: null,
      reason: 'Margins above 100% cannot be solved for a suggested price.'
    };
  }

  const suggestedPrice = cost / (1 - marginPercent / 100);
  return { suggestedPrice, reason: null };
}

/**
 * Compute the ACTUAL current gross margin from a real cost and a real
 * selling price. This is the authoritative, after-the-fact figure — PRD
 * §20: "After the user manually sets or accepts a selling price, the
 * application recalculates the actual margin."
 *
 * margin = (sellingPrice - cost) / sellingPrice × 100
 *
 * @param {number} cost
 * @param {number} sellingPrice
 * @returns {{ marginPercent: number|null, reason: string|null }}
 *   marginPercent is null (with `reason`) when sellingPrice is 0 — margin
 *   as a percentage OF the selling price is undefined when that price is
 *   zero, regardless of cost. A negative or free-giveaway selling price
 *   relative to cost still produces a valid (negative) margin otherwise.
 */
export function calculateActualMargin(cost, sellingPrice) {
  if (typeof cost !== 'number' || !Number.isFinite(cost)) {
    throw new TypeError('calculateActualMargin requires a finite cost.');
  }
  if (typeof sellingPrice !== 'number' || !Number.isFinite(sellingPrice)) {
    throw new TypeError('calculateActualMargin requires a finite sellingPrice.');
  }

  if (sellingPrice === 0) {
    return {
      marginPercent: null,
      reason: 'Margin is undefined when selling price is ₹0.'
    };
  }

  const marginPercent = ((sellingPrice - cost) / sellingPrice) * 100;
  return { marginPercent, reason: null };
}
