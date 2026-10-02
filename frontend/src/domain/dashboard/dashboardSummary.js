// Dashboard derivations (Phase 7C).
//
// Pure functions over already-loaded data. No React, no IndexedDB, no
// fetch. Everything here is DERIVED from products and stock events; nothing
// is persisted and nothing is estimated.
//
// What the dashboard deliberately does NOT derive (Issue #19: "Never
// invent approximate financial values"):
//   - inventory cost / expected profit: Product carries no cost, and cost
//     of the units still on the shelf is not tracked (no FIFO), so any
//     total would be an estimate.
//   - total units: quantities are in mixed units (kg, pieces, ...), so
//     their sum has no meaning.
//
// Stock status is NOT re-implemented here: classifyStockStatus() is the
// single source of truth, shared with the list and detail pages.

import { classifyStockStatus, STOCK_STATUS } from '../classification/lowStock.js';
import { STOCK_EVENT_TYPE } from '../../../../shared/constants.js';

function displayName(product) {
  return typeof product.name === 'string' && product.name.trim() !== ''
    ? product.name.trim()
    : 'Unnamed product';
}

function byNameThenId(a, b) {
  const byName = displayName(a).localeCompare(displayName(b), undefined, { sensitivity: 'base' });
  return byName !== 0 ? byName : String(a.id).localeCompare(String(b.id));
}

function isPriced(product) {
  return typeof product.sellingPrice === 'number' && Number.isFinite(product.sellingPrice);
}

/**
 * Summarize inventory for the dashboard.
 *
 * Archived products are excluded from every figure (PRD §28).
 *
 * @param {object[]} products Any mix of active and archived products.
 * @param {{ globalDefaultThreshold: number }} options
 * @returns {{
 *   totalProducts: number,
 *   lowStockCount: number,
 *   outOfStockCount: number,
 *   lowStock: object[],     Low Stock products, most urgent (lowest quantity) first
 *   outOfStock: object[],   Out of Stock products, by name
 *   expectedSellingValue: null | { total: number, pricedCount: number, unpricedCount: number }
 * }}
 *   expectedSellingValue is null unless at least one active product has a
 *   selling price. When present it covers PRICED products only;
 *   unpricedCount says how many active products it leaves out.
 * @throws {TypeError} If products is not an array, or a product has a
 *   malformed quantity (propagated from classifyStockStatus: bad stored
 *   data is surfaced, not silently skipped).
 */
export function summarizeInventory(products, { globalDefaultThreshold } = {}) {
  if (!Array.isArray(products)) {
    throw new TypeError('summarizeInventory requires an array of products.');
  }

  const active = products.filter((p) => p && p.archived !== true);

  const lowStock = [];
  const outOfStock = [];
  let pricedCount = 0;
  let unpricedCount = 0;
  let total = 0;

  for (const product of active) {
    const status = classifyStockStatus({
      quantity: product.quantity,
      globalDefaultThreshold,
      productThresholdOverride: product.lowStockThreshold,
      lowStockDisabled: product.lowStockDisabled
    });

    if (status === STOCK_STATUS.OUT) outOfStock.push(product);
    else if (status === STOCK_STATUS.LOW) lowStock.push(product);

    if (isPriced(product)) {
      pricedCount += 1;
      total += product.quantity * product.sellingPrice;
    } else {
      unpricedCount += 1;
    }
  }

  lowStock.sort((a, b) => a.quantity - b.quantity || byNameThenId(a, b));
  outOfStock.sort(byNameThenId);

  return {
    totalProducts: active.length,
    lowStockCount: lowStock.length,
    outOfStockCount: outOfStock.length,
    lowStock,
    outOfStock,
    expectedSellingValue: pricedCount > 0 ? { total, pricedCount, unpricedCount } : null
  };
}

/**
 * Turn a stored stock event into what the "Recently updated" feed shows.
 *
 * The signed amount is what ACTUALLY changed the product's quantity:
 * for a REMOVE that was clamped at zero (over-removal) that is
 * appliedQuantity, not the requested quantity. Rows written without an
 * appliedQuantity fall back to the requested quantity.
 *
 * @param {object} event Stored stock event row.
 * @returns {{
 *   id: string,
 *   productId: string,
 *   direction: 'added' | 'removed',
 *   amount: number,
 *   isReversal: boolean,
 *   recordedAt: string
 * }}
 */
export function toActivityEntry(event) {
  const amount =
    typeof event.appliedQuantity === 'number' && Number.isFinite(event.appliedQuantity)
      ? event.appliedQuantity
      : event.quantity;

  return {
    id: event.id,
    productId: event.productId,
    direction: event.type === STOCK_EVENT_TYPE.ADD ? 'added' : 'removed',
    amount,
    isReversal: typeof event.reversalOf === 'string' && event.reversalOf !== '',
    recordedAt: event.recordedAt
  };
}
