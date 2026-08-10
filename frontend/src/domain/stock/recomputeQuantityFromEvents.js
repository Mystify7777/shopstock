// recomputeQuantityFromEvents — full replay of a product's StockEvent
// history, for reconciliation.
//
// Scope: this is the "recompute from scratch" counterpart to
// applyStockEvent.js's "apply one new event" — see
// docs/ARCHITECTURE.md, "Product.quantity — materialized state," which
// names this exact function as the reconciliation path (e.g. after a sync
// pulls down events a device didn't have locally, or any time the
// materialized `Product.quantity` is suspected to have drifted from what
// the event stream actually implies). This function only cares about
// applyStockEvent()'s `nextQuantity` result — it has no use for
// `appliedQuantity` (that value only matters to reversal.js, which needs
// to know the true effect of an over-removal at the moment it happens;
// replaying history from scratch has no reversals-in-progress to feed it
// to).
//
// TWO DECISIONS THIS FILE LOCKS IN, both load-bearing:
//
//   1. Replay ALWAYS starts from 0, never from the current
//      Product.quantity. If the materialized quantity were used as the
//      starting point, an already-corrupted quantity would contaminate
//      the very replay meant to fix it — the event stream is supposed to
//      be authoritative (docs/ARCHITECTURE.md), and authoritative means
//      independent of whatever the (possibly wrong) materialized value
//      currently says.
//
//   2. Replay preserves the SUPPLIED ORDER of the events array and does
//      NOT sort by recordedAt (or anything else). Quantity is
//      order-sensitive in a way cost is not, because REMOVE clamps at
//      zero (applyStockEvent.js):
//
//        ADD 5, REMOVE 8, ADD 10  ->  5 -> 0 -> 10   (final: 10)
//        ADD 10, ADD 5, REMOVE 8  ->  10 -> 15 -> 7   (final: 7)
//
//      Same three events, different order, different final quantity. This
//      function is a pure reducer over whatever order it's given — it is
//      the CALLER's (repository's) responsibility to supply events in
//      true canonical/chronological order. This file must never invent an
//      ordering policy of its own by silently sorting.
//
// This file does NOT interpret `reversalOf`/`reversedBy` in any special
// way — a reversal event is just another ADD or REMOVE as far as this
// reducer is concerned, applied in the position it's given. Any special
// handling of reversal semantics belongs to reversal.js, not here.

import { applyStockEvent } from './applyStockEvent.js';

/**
 * Replay a full stock-event history from scratch and return the resulting
 * quantity.
 *
 * @param {object[]} events The product's stock events, in canonical order
 *   (whatever order the repository considers authoritative — typically
 *   chronological by recordedAt, but this function does not assume or
 *   enforce that; it simply reduces over the array as given). Must be a
 *   real array — an empty array (`[]`) is a valid, meaningful "no history
 *   yet" input and returns 0. `null`/`undefined`/anything non-array is
 *   NOT treated the same as an empty array: this function is explicitly a
 *   reconciliation mechanism, so a malformed top-level input should
 *   surface loudly as a data-layer bug rather than being silently
 *   swallowed into "0, no history" — the two situations mean very
 *   different things and must not be conflated.
 * @returns {number} The recomputed quantity. Always finite and >= 0
 *   (applyStockEvent.js guarantees this at every step).
 * @throws {TypeError} If `events` is not an array at all, or (propagated
 *   directly from applyStockEvent()) if any event in the list is
 *   malformed (unrecognized type, non-positive or non-finite quantity).
 */
export function recomputeQuantityFromEvents(events) {
  if (!Array.isArray(events)) {
    throw new TypeError(
      'recomputeQuantityFromEvents requires an array of stock events (an ' +
        'empty array is fine; null/undefined is not — this function is a ' +
        'reconciliation mechanism and must not silently treat missing ' +
        'data the same as a genuinely empty history).'
    );
  }

  let quantity = 0;
  for (const event of events) {
    quantity = applyStockEvent(quantity, event).nextQuantity;
  }
  return quantity;
}
