// recomputeQuantityFromEvents — full replay of a product's StockEvent
// history, for reconciliation.
//
// Scope: this is the "recompute from scratch" counterpart to
// applyStockEvent.js's "apply one new event" — see
// docs/ARCHITECTURE.md, "Product.quantity — materialized state," which
// names this exact function as the reconciliation path (e.g. after a sync
// pulls down events a device didn't have locally, or any time the
// materialized `Product.quantity` is suspected to have drifted from what
// the event stream actually implies).
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
 *   enforce that; it simply reduces over the array as given).
 * @returns {number} The recomputed quantity. Always finite and >= 0
 *   (applyStockEvent.js guarantees this at every step).
 * @throws {TypeError} Propagated directly from applyStockEvent() if any
 *   event in the list is malformed (unrecognized type, non-positive or
 *   non-finite quantity). A malformed event reaching this point indicates
 *   corrupted stored data, which should surface loudly during
 *   reconciliation rather than being silently skipped or defaulted.
 */
export function recomputeQuantityFromEvents(events) {
  const eventList = Array.isArray(events) ? events : [];

  let quantity = 0;
  for (const event of eventList) {
    quantity = applyStockEvent(quantity, event);
  }
  return quantity;
}
