// Product construction and controlled updates.
//
// Scope, deliberately narrow (see docs/PROGRESS.md discussion before this
// file was written): this factory is responsible for CONSTRUCTION and
// CONTROLLED UPDATES of Product objects. It is explicitly NOT responsible
// for:
//   - cost/margin/suggested-price calculations (that's domain/pricing/)
//   - deciding when a ProductChangeEvent should be created (that's
//     services/ — orchestration territory; this file has no idea
//     ProductChangeEvent exists)
//   - persistence (that's data/repositories/)
//   - quantity mutation (that's exclusively applyStockEvent.js — see
//     docs/ARCHITECTURE.md, "Product.quantity — materialized state, not a
//     second source of truth")
//
// Two invariants this file exists to enforce in code, not just in docs:
//
//   1. quantity can ONLY be set by createProduct() (as the explicit
//      starting quantity) or by applyStockEvent.js. updateProduct() will
//      THROW if a patch attempts to touch quantity at all — including
//      setting it to its current value. This is deliberately strict:
//      "quantity" should never appear in a generic edit-product patch, so
//      any attempt to include it — even harmlessly — is almost certainly
//      a caller reaching for the wrong function, and should fail loudly
//      at development time rather than silently working by coincidence.
//
//   2. updateProduct() is a PATCH, not a merge-with-defaults. A key that is
//      omitted from the patch is left untouched. A key explicitly present
//      with value `null` (or `''`, or `0`, or `false`) is APPLIED as given.
//      This distinguishes "the caller didn't mention notes" from "the
//      caller wants notes cleared," which matters because several Product
//      fields have `null` as a meaningful value (see productValidation.js
//      — null margin/threshold means "use global default").

import { generateId, isValidId } from '../shared/ids.js';
import { timestampNow } from '../shared/dates.js';
import { validateProduct } from './productValidation.js';

/**
 * Fields a caller is never allowed to set through updateProduct(), because
 * each is owned by a different, more specific mechanism elsewhere in the
 * domain. Listed together so the enforcement and the reasoning live next
 * to each other instead of drifting apart.
 */
const LOCKED_UPDATE_FIELDS = {
  id: 'id is immutable once a product is created.',
  createdAt: 'createdAt is immutable once a product is created.',
  quantity:
    'quantity cannot be set through updateProduct() — stock changes must ' +
    'go through a StockEvent and applyStockEvent(). See ' +
    'docs/ARCHITECTURE.md, "Product.quantity — materialized state."'
};

/**
 * Create a new, valid Product with sensible, EXPLICIT defaults (never left
 * as `undefined`) for every field the domain model defines.
 *
 * @param {object} [input]
 * @param {string} [input.name]
 * @param {string} [input.photoRef]
 * @param {number} [input.quantity] Starting quantity. Defaults to 0. This
 *   is the one place outside applyStockEvent.js allowed to set quantity —
 *   establishing a starting count at creation time is not the same
 *   operation as mutating an existing product's count later.
 * @param {string} [input.unitId]
 * @param {number|null} [input.lowStockThreshold]
 * @param {boolean} [input.lowStockDisabled]
 * @param {string|null} [input.categoryId]
 * @param {string[]} [input.locationIds]
 * @param {string[]} [input.tagIds]
 * @param {number|null} [input.sellingPrice]
 * @param {number|null} [input.marginOverride]
 * @param {string|null} [input.latestPurchaseDate]
 * @param {string|null} [input.notes]
 * @returns {{ product: object, errors: string[] }} The constructed product
 *   (always returned, even if invalid, so a caller can show it back to the
 *   user for correction) and any validation errors. Check `errors.length
 *   === 0` before persisting.
 */
export function createProduct(input = {}) {
  const now = timestampNow();

  const product = {
    id: isValidId(input.id) ? input.id : generateId(),
    name: input.name ?? null,
    photoRef: input.photoRef ?? null,
    quantity: input.quantity ?? 0,
    unitId: input.unitId ?? null,
    lowStockThreshold: input.lowStockThreshold ?? null,
    lowStockDisabled: input.lowStockDisabled ?? false,
    categoryId: input.categoryId ?? null,
    locationIds: input.locationIds ?? [],
    tagIds: input.tagIds ?? [],
    sellingPrice: input.sellingPrice ?? null,
    marginOverride: input.marginOverride ?? null,
    latestPurchaseDate: input.latestPurchaseDate ?? null,
    notes: input.notes ?? null,
    createdAt: now,
    updatedAt: now,
    archived: false
  };

  const errors = validateProduct(product);
  return { product, errors };
}

/**
 * Apply a controlled patch to an existing product.
 *
 * PATCH semantics, not merge-with-defaults:
 *   - a key absent from `patch` leaves that field on `product` untouched
 *   - a key present in `patch` (including `null`, `0`, `false`, `''`) is
 *     applied exactly as given
 *
 * `id`, `createdAt`, and `quantity` may never appear in `patch` — this
 * function throws immediately if any of them are present, rather than
 * silently ignoring them, so a caller reaching for the wrong tool finds
 * out right away instead of six months from now.
 *
 * @param {object} product An existing product (assumed already valid).
 * @param {object} patch Partial fields to change.
 * @returns {{ product: object, errors: string[] }} The updated product and
 *   any validation errors produced by re-validating the result.
 * @throws {TypeError} If `product` is missing/invalid, or if `patch`
 *   attempts to set a locked field.
 */
export function updateProduct(product, patch = {}) {
  if (!product || typeof product !== 'object') {
    throw new TypeError('updateProduct requires an existing product object.');
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('updateProduct requires a patch object.');
  }

  for (const field of Object.keys(LOCKED_UPDATE_FIELDS)) {
    if (Object.prototype.hasOwnProperty.call(patch, field)) {
      throw new TypeError(LOCKED_UPDATE_FIELDS[field]);
    }
  }

  const updated = {
    ...product,
    ...patch,
    // Re-assert these no matter what — belt-and-suspenders alongside the
    // throw above, in case a future edit to this function ever loosens
    // the check but forgets to also stop the spread from letting them in.
    id: product.id,
    createdAt: product.createdAt,
    quantity: product.quantity,
    updatedAt: timestampNow()
  };

  const errors = validateProduct(updated);
  return { product: updated, errors };
}

/**
 * The list of field names updateProduct() refuses to accept, exported so
 * callers (and tests) can reference it instead of duplicating the literal
 * list.
 */
export const LOCKED_PRODUCT_UPDATE_FIELDS = Object.keys(LOCKED_UPDATE_FIELDS);
