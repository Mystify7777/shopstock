// applyStockEvent — THE single function permitted to compute the next
// Product.quantity from (currentQuantity, event).
//
// docs/ARCHITECTURE.md, "Product.quantity — materialized state, not a
// second source of truth": Product.quantity is a materialized projection
// of the StockEvent stream. This file is the ONE place that projection
// math happens for a single new event. (Full replay of an entire event
// history, e.g. for post-sync reconciliation, is a different function —
// recomputeQuantityFromEvents.js, next in the sequence — which is built
// on top of this one rather than duplicating its arithmetic.)
//
// This file does NOT:
//   - decide whether to warn about an over-removal (PRD §12 — that's a
//     UI/service decision, made BEFORE calling this function, by comparing
//     event.quantity against the product's current quantity)
//   - reject, mutate, or annotate the event itself — the event is an
//     honest, permanent record of what the user actually did, even if
//     more was removed than was available
//   - allow the resulting quantity to be negative — see "the over-removal
//     reconciliation" below for why, and why clamping (not rejecting, not
//     going negative) is the correct resolution
//
// THE OVER-REMOVAL RECONCILIATION (the one subtle decision this file
// encodes): PRD §12 requires that a user be ALLOWED to remove more stock
// than is currently available, after a warning — the operation must not
// be silently blocked. Separately, productValidation.js enforces that
// Product.quantity can never be negative — that's a real, load-bearing
// structural invariant (a negative "5 biscuits" on a shelf is meaningless
// to a shop owner, and would break every place quantity is displayed or
// compared). Those two requirements only look like they conflict if you
// assume the event and the materialized quantity have to tell the same
// story. They don't have to:
//
//   StockEvent (immutable history):  "user removed 8 units" — recorded
//                                     exactly as it happened, unmutated,
//                                     regardless of what was available.
//   Product.quantity (materialized): clamped to 0 — the shop's on-shelf
//                                     count cannot be negative, so the
//                                     projection stops at the floor.
//
// So: REMOVE never produces a negative next-quantity. It clamps at 0. The
// event that caused the clamp is untouched — nothing about the event
// records "well actually only 5 were removed" or similar; the full
// requested quantity (8) remains in the permanent record.
//
// WHY THIS FUNCTION RETURNS { nextQuantity, appliedQuantity } RATHER THAN
// A BARE NUMBER: "requested quantity" (what the event says) and "applied
// quantity" (how much actually changed the materialized total) are
// genuinely different numbers under clamping, and BOTH matter to
// different callers:
//   - nextQuantity   is what a repository writes to Product.quantity.
//   - appliedQuantity is what actually happened to inventory — for ADD,
//     always equal to event.quantity; for REMOVE, equal to
//     min(event.quantity, currentQuantity) — i.e. it's exactly
//     `currentQuantity - nextQuantity`.
//
// This distinction exists specifically so reversal.js can undo the TRUE
// effect of an over-removal rather than blindly re-adding the requested
// (and possibly inventory-inflating) amount. Reversing a REMOVE 8 that
// only actually removed 5 (because only 5 were available) must restore 5,
// not 8 — otherwise "undo" manufactures 3 units of inventory out of
// nothing. appliedQuantity is only knowable at the exact moment of
// applying the event against a specific currentQuantity — it cannot be
// recovered later from the event alone (the event is immutable and only
// ever records the requested amount) — so it MUST be captured here, at
// commit time, and threaded through to whatever creates the reversal.
// See docs/ARCHITECTURE.md's over-removal-reversal corollary for the full
// reasoning and the concrete worked example.

import { STOCK_EVENT_TYPE } from './stockEventFactory.js';

/**
 * Compute the next materialized quantity, and the true applied delta,
 * after applying a single stock event to a current quantity.
 *
 * @param {number} currentQuantity The product's current materialized
 *   quantity. Must be a finite number >= 0 (the invariant this function
 *   itself maintains — callers should never be able to hand it an
 *   already-invalid starting point in normal operation).
 * @param {{ type: 'ADD'|'REMOVE', quantity: number }} event A stock event,
 *   as produced by stockEventFactory.js. Only `type` and `quantity` are
 *   read; other event fields (cost, comment, timestamps) are irrelevant to
 *   this calculation.
 * @returns {{ nextQuantity: number, appliedQuantity: number }}
 *   nextQuantity    — the new materialized Product.quantity. Always
 *                      finite and >= 0.
 *   appliedQuantity — how much of the requested event.quantity actually
 *                      took effect. Equals event.quantity for ADD.
 *                      For REMOVE, equals min(event.quantity,
 *                      currentQuantity) — less than event.quantity only
 *                      when the removal was clamped.
 * @throws {TypeError} If currentQuantity is not a finite number >= 0, or
 *   if the event is missing/malformed (unknown type, non-finite or
 *   non-positive quantity). This function does not silently tolerate a
 *   malformed event — a malformed event reaching this point is a bug
 *   upstream (stockEventFactory.js already rejects these at construction
 *   time), not a case to handle gracefully here.
 */
export function applyStockEvent(currentQuantity, event) {
  if (typeof currentQuantity !== 'number' || !Number.isFinite(currentQuantity)) {
    throw new TypeError('applyStockEvent requires a finite currentQuantity.');
  }
  if (currentQuantity < 0) {
    throw new TypeError('applyStockEvent requires a non-negative currentQuantity.');
  }
  if (!event || typeof event !== 'object') {
    throw new TypeError('applyStockEvent requires a stock event.');
  }
  if (typeof event.quantity !== 'number' || !Number.isFinite(event.quantity) || event.quantity <= 0) {
    throw new TypeError('applyStockEvent requires the event to have a quantity greater than 0.');
  }

  if (event.type === STOCK_EVENT_TYPE.ADD) {
    return {
      nextQuantity: currentQuantity + event.quantity,
      appliedQuantity: event.quantity
    };
  }

  if (event.type === STOCK_EVENT_TYPE.REMOVE) {
    // Clamped at 0 — see "THE OVER-REMOVAL RECONCILIATION" above. The
    // event itself is never touched; only the materialized result is
    // floored. appliedQuantity captures exactly how much of the request
    // actually came off the shelf, which is <= event.quantity.
    const appliedQuantity = Math.min(event.quantity, currentQuantity);
    return {
      nextQuantity: currentQuantity - appliedQuantity,
      appliedQuantity
    };
  }

  throw new TypeError(`applyStockEvent does not recognize event type "${event.type}".`);
}

/**
 * Would applying this REMOVE event take the product below its current
 * available quantity — i.e. should the UI show the PRD §12 warning
 * ("Only 5 units are currently available. Remove 8 anyway?") before this
 * event is committed?
 *
 * This is intentionally a separate, side-effect-free question function
 * rather than something applyStockEvent() itself decides — the warning is
 * a UI/service-layer concern that happens BEFORE an event is constructed
 * and applied, not a branch inside the deterministic math above.
 *
 * @param {number} currentQuantity
 * @param {{ type: string, quantity: number }} event
 * @returns {boolean} True only for a REMOVE event whose quantity exceeds
 *   currentQuantity. Always false for ADD.
 */
export function wouldOverRemove(currentQuantity, event) {
  if (typeof currentQuantity !== 'number' || !Number.isFinite(currentQuantity)) {
    return false;
  }
  if (!event || event.type !== STOCK_EVENT_TYPE.REMOVE) {
    return false;
  }
  if (typeof event.quantity !== 'number' || !Number.isFinite(event.quantity)) {
    return false;
  }
  return event.quantity > currentQuantity;
}
