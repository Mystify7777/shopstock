// Stock event construction.
//
// Scope, deliberately narrow: this file builds well-formed ADD/REMOVE
// StockEvent objects. It does NOT:
//   - modify Product.quantity — that's exclusively applyStockEvent.js
//     (docs/ARCHITECTURE.md, "Product.quantity — materialized state")
//   - decide over-removal warnings — that's a service-layer/UI concern
//     (PRD §12: "the system should allow removal past available stock,
//     but must warn first" — the warning is a UI interaction, not a
//     construction-time validation failure)
//   - persist anything, or touch the sync queue
//   - choose a cost value on the caller's behalf — see "cost is a prefill
//     suggestion, not factory logic" below
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE IN CODE:
//
//   purchaseDate = when the goods were purchased (user-editable, defaults
//                  to today, ADD only)
//   recordedAt   = when this stock operation was entered into ShopStock
//                  (always factory-generated, NEVER trusted from caller
//                  input, immutable once set)
//
// These must never be conflated. costCalculations.js already made
// `recordedAt` authoritative for "latest known cost" — if this file let a
// caller pass in a fake recordedAt, or used purchaseDate where recordedAt
// belongs, that decision would be silently corrupted. So `recordedAt` is
// ALWAYS generated here, in full, regardless of what a caller supplies.

import { generateId } from '../shared/ids.js';
import { timestampNow, todayDateOnly, isValidDateOnly } from '../shared/dates.js';

export const STOCK_EVENT_TYPE = Object.freeze({
  ADD: 'ADD',
  REMOVE: 'REMOVE'
});

/**
 * Normalize an optional comment: trims whitespace, and converts an empty
 * result to `null`. The factory never invents a comment — PRD §12/§18 are
 * explicit that "No justification provided" is DISPLAY text for an absent
 * comment, not something stored as if the user typed it. A `null` comment
 * here is what the UI later renders as that phrase; this file just makes
 * sure "the user typed nothing" and "the user typed three spaces" both
 * consistently become `null` rather than one becoming an empty string and
 * the other `null`.
 *
 * @param {*} comment
 * @returns {string|null}
 */
function normalizeComment(comment) {
  if (typeof comment !== 'string') {
    return null;
  }
  const trimmed = comment.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Build a stock ADDITION event (PRD §11.1).
 *
 * Cost behavior — READ CAREFULLY: this function does NOT look up "the
 * latest known cost" and does NOT fill in a cost the caller didn't
 * provide. Prefilling the cost-per-unit FIELD IN A FORM with the latest
 * known cost (PRD §11.1: "the cost field should automatically be prefilled
 * with the latest known cost") is a UI/service concern — by the time a
 * caller reaches this factory, they have already decided what value (if
 * any) the user accepted, changed, or deliberately cleared. This function
 * simply records whatever `costPerUnit` it's given, treating `undefined`/
 * `null`/omitted identically as "no cost recorded" (PRD §11.1: "If the
 * user deliberately clears the cost, the stock addition is recorded
 * without a cost").
 *
 * @param {object} input
 * @param {number} input.quantity Must be a finite number > 0.
 * @param {number|null} [input.costPerUnit] Cost per unit, or null/omitted
 *   for no recorded cost.
 * @param {string|null} [input.purchaseDate] Date-only string
 *   ("YYYY-MM-DD"). Defaults to today (local calendar day) if omitted —
 *   matching PRD §11.2 ("purchaseDate defaults to today"). Pass null
 *   explicitly only if you have a specific reason to store no purchase
 *   date at all; omission is the normal "use today" path.
 * @param {string} [input.comment]
 * @returns {{ event: object, errors: string[] }}
 */
export function createAddStockEvent({ productId, quantity, costPerUnit, purchaseDate, comment } = {}) {
  const errors = [];

  if (typeof productId !== 'string' || productId.trim().length === 0) {
    errors.push('A stock addition must be linked to a product.');
  }

  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) {
    errors.push('Quantity must be greater than 0.');
  }

  let normalizedCost = null;
  if (costPerUnit !== undefined && costPerUnit !== null) {
    if (typeof costPerUnit !== 'number' || !Number.isFinite(costPerUnit) || costPerUnit < 0) {
      errors.push('Cost per unit must be a non-negative number, or left blank.');
    } else {
      normalizedCost = costPerUnit;
    }
  }

  // purchaseDate: explicit undefined -> default to today. Explicit value
  // -> must be a valid date-only string. Explicit null is accepted as "no
  // purchase date on record" without defaulting, for callers with a
  // specific reason to omit it (e.g. a bulk historical import where the
  // date is genuinely unknown) — but ordinary UI flows should simply omit
  // the field to get today's date, matching PRD §11.2.
  let normalizedPurchaseDate;
  if (purchaseDate === undefined) {
    normalizedPurchaseDate = todayDateOnly();
  } else if (purchaseDate === null) {
    normalizedPurchaseDate = null;
  } else if (!isValidDateOnly(purchaseDate)) {
    errors.push('Purchase date is not a valid date.');
    normalizedPurchaseDate = purchaseDate; // preserved for caller inspection, still invalid
  } else {
    normalizedPurchaseDate = purchaseDate;
  }

  const event = {
    id: generateId(),
    productId: typeof productId === 'string' ? productId : null,
    type: STOCK_EVENT_TYPE.ADD,
    quantity: typeof quantity === 'number' ? quantity : null,
    costPerUnit: normalizedCost,
    purchaseDate: normalizedPurchaseDate,
    // recordedAt is ALWAYS generated here. A caller cannot pass one in —
    // createAddStockEvent doesn't even read an input.recordedAt field.
    recordedAt: timestampNow(),
    comment: normalizeComment(comment),
    reversalOf: null,
    reversedBy: null
  };

  return { event, errors };
}

/**
 * Build a stock REMOVAL event (PRD §12).
 *
 * Deliberately has NO costPerUnit and NO purchaseDate parameters at all —
 * PRD §12 only lists quantity and an optional comment for removals, and
 * Build Brief §12 confirms cost is only meaningful for ADD. Omitting these
 * parameters from the function signature (rather than accepting-and-
 * ignoring them) makes misuse a call-site error, not a silent no-op.
 *
 * This function does NOT decide whether the removal exceeds available
 * stock, and does NOT block construction if it would — PRD §12 requires
 * that the user be allowed to proceed after a warning, so "would this
 * over-remove" is a question for the caller to ask (typically against
 * Product.quantity) BEFORE calling this, in order to show that warning.
 * Once the caller decides to proceed, this factory just builds the event.
 *
 * @param {object} input
 * @param {string} input.productId
 * @param {number} input.quantity Must be a finite number > 0.
 * @param {string} [input.comment]
 * @returns {{ event: object, errors: string[] }}
 */
export function createRemoveStockEvent({ productId, quantity, comment } = {}) {
  const errors = [];

  if (typeof productId !== 'string' || productId.trim().length === 0) {
    errors.push('A stock removal must be linked to a product.');
  }

  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) {
    errors.push('Quantity must be greater than 0.');
  }

  const event = {
    id: generateId(),
    productId: typeof productId === 'string' ? productId : null,
    type: STOCK_EVENT_TYPE.REMOVE,
    quantity: typeof quantity === 'number' ? quantity : null,
    costPerUnit: null,
    purchaseDate: null,
    recordedAt: timestampNow(),
    comment: normalizeComment(comment),
    reversalOf: null,
    reversedBy: null
  };

  return { event, errors };
}

/**
 * Is this a structurally well-formed stock event of either type?
 * A light shape check, useful for defensive guards elsewhere in the
 * domain (e.g. costCalculations.js's own internal filtering already
 * checks `type === 'ADD'` directly, but a repository loading events back
 * out of IndexedDB might want a single sanity check).
 *
 * @param {*} event
 * @returns {boolean}
 */
export function isValidStockEventShape(event) {
  if (!event || typeof event !== 'object') return false;
  if (event.type !== STOCK_EVENT_TYPE.ADD && event.type !== STOCK_EVENT_TYPE.REMOVE) {
    return false;
  }
  if (typeof event.quantity !== 'number' || !Number.isFinite(event.quantity) || event.quantity <= 0) {
    return false;
  }
  if (typeof event.recordedAt !== 'string' || event.recordedAt.length === 0) {
    return false;
  }
  return true;
}
