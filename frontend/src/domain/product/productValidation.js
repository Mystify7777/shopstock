// Product identity validation.
//
// Scope, deliberately narrow: this file validates the ONE structural
// invariant the PRD defines for product identity (§4.1 / Build Brief §6),
// plus the handful of other domain-level invariants a Product must satisfy
// regardless of how it got constructed (quantity can't be negative, etc).
//
// This file does NOT validate:
//   - UI/form state (React errors, dropdown loading, file picker state)
//   - whether referenced ids (categoryId, unitId, locationIds) actually
//     exist — that's a repository-layer concern, since it requires reading
//     other tables, and domain validation must stay dependency-free
//   - anything about how a photo was captured/uploaded — only whether a
//     photo reference is present
//
// PRD §4.1 / Build Brief §6 — the identity rule:
//   valid   := name is non-empty (after trimming) OR photo exists
//   invalid := name is empty AND photo is empty
//   a photo-only product (no name) is explicitly valid

import { isValidId } from '../shared/ids.js';

/**
 * Is this a non-empty product name? Whitespace-only counts as empty —
 * PRD examples always show real text; a name of "   " would be
 * indistinguishable from "no name" to a shop owner scanning a list.
 *
 * @param {*} name
 * @returns {boolean}
 */
function hasName(name) {
  return typeof name === 'string' && name.trim().length > 0;
}

/**
 * Is this a present photo reference? A photo reference is a string id
 * pointing into local photo storage (see docs/ARCHITECTURE.md — "Photo
 * storage — provider abstraction"); this function only checks presence,
 * not whether the blob it points to actually exists in storage — that's a
 * repository/photo-storage concern, not a domain-validation one.
 *
 * @param {*} photoRef
 * @returns {boolean}
 */
function hasPhoto(photoRef) {
  return typeof photoRef === 'string' && photoRef.trim().length > 0;
}

/**
 * The core identity rule (PRD §4.1): a product is identity-valid if it has
 * a name, a photo, or both. Invalid only when both are absent.
 *
 * @param {{ name?: string, photoRef?: string }} product
 * @returns {boolean}
 */
export function hasValidIdentity(product) {
  if (!product || typeof product !== 'object') {
    return false;
  }
  return hasName(product.name) || hasPhoto(product.photoRef);
}

/**
 * Validate a product's structural invariants and return a human-readable
 * list of problems, if any. Returns an empty array when the product is
 * fully valid.
 *
 * This checks the identity rule plus the other invariants a Product must
 * satisfy at the domain level regardless of construction path:
 *   - quantity, if present, must be a finite number >= 0
 *   - lowStockThreshold, if present (and not null), must be a finite
 *     number >= 0
 *   - marginOverride, if present (and not null), must be a finite number
 *     (negative margins are unusual but not meaningless — a shop might
 *     deliberately sell below cost as a loss leader — so this only rejects
 *     non-numeric/non-finite values, not negative ones)
 *   - locationIds / tagIds, if present, must be arrays
 *
 * Messages are written to be shown directly to a non-technical shop owner,
 * per Build Brief §37 ("Validation should be human-readable").
 *
 * @param {object} product
 * @returns {string[]} Empty if valid; otherwise one message per problem.
 */
export function validateProduct(product) {
  const errors = [];

  if (!product || typeof product !== 'object') {
    return ['Product data is missing or invalid.'];
  }

  if (!hasValidIdentity(product)) {
    errors.push('Product needs a name or photo.');
  }

  if (product.quantity !== undefined) {
    if (typeof product.quantity !== 'number' || !Number.isFinite(product.quantity)) {
      errors.push('Quantity must be a number.');
    } else if (product.quantity < 0) {
      errors.push('Quantity cannot be negative.');
    }
  }

  if (product.lowStockThreshold !== undefined && product.lowStockThreshold !== null) {
    if (
      typeof product.lowStockThreshold !== 'number' ||
      !Number.isFinite(product.lowStockThreshold)
    ) {
      errors.push('Low-stock threshold must be a number.');
    } else if (product.lowStockThreshold < 0) {
      errors.push('Low-stock threshold cannot be negative.');
    }
  }

  if (product.marginOverride !== undefined && product.marginOverride !== null) {
    if (
      typeof product.marginOverride !== 'number' ||
      !Number.isFinite(product.marginOverride)
    ) {
      errors.push('Margin must be a number.');
    }
  }

  if (product.locationIds !== undefined && !Array.isArray(product.locationIds)) {
    errors.push('Locations must be a list.');
  }

  if (product.tagIds !== undefined && !Array.isArray(product.tagIds)) {
    errors.push('Tags must be a list.');
  }

  if (product.id !== undefined && !isValidId(product.id)) {
    errors.push('Product is missing a valid id.');
  }

  return errors;
}

/**
 * Convenience boolean wrapper around validateProduct — true when there are
 * no validation errors at all.
 *
 * @param {object} product
 * @returns {boolean}
 */
export function isProductValid(product) {
  return validateProduct(product).length === 0;
}
