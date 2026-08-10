// Reversal / undo logic.
//
// Scope: this file builds the COMPENSATING event for a stock event that's
// being reversed, and links the two together. It does NOT:
//   - modify Product.quantity (applyStockEvent.js's job, applied to the
//     reversal event exactly like any other event)
//   - decide the 5-second undo timer, or render any toast/UI — that's a
//     service/UI concern (PRD §14)
//   - persist anything
//
// THE CENTRAL DESIGN DECISION THIS FILE ENCODES: undo and historical
// reversal are the SAME OPERATION, not two different domain concepts.
//
//   PRD §14 (Undo): a ~5-second toast after a stock mutation, offering to
//     reverse it immediately.
//   PRD §15 (Historical Reversal): any past stock event can be reversed
//     later, at any time, from its history entry.
//
// The only difference between these two is WHEN the user chooses to
// reverse something and HOW they got there (a toast vs. browsing history)
// — not what reversing actually does. So there is exactly one function
// here, createReversalEvent(), and the "5-second undo" is just that
// function called very soon after the original event, by a UI timer that
// lives entirely outside the domain layer. There is no separate "UndoEvent"
// type and no "was this an undo or a reversal" flag anywhere in the event
// shape — that distinction doesn't exist in the domain model on purpose.
//
// REVERSALS ARE THEMSELVES REVERSIBLE (docs/ARCHITECTURE.md assumption
// #2). A reversal event is not special — it's an ordinary ADD or REMOVE
// event (opposite type/quantity of what it reverses) that happens to carry
// a `reversalOf` reference. Nothing stops calling createReversalEvent()
// again on a reversal event; doing so produces a second-order reversal
// that points back at the reversal, which points back at the original.
// This keeps the reference chain a simple singly-linked list in each
// direction (reversalOf points backward one step, reversedBy points
// forward one step) rather than a tangled graph — see "second-order
// reversal" below for the one rule that keeps this clean: an event that
// has ALREADY been reversed cannot be reversed again directly; you reverse
// its reversal instead, which is a different, always-permitted operation.
//
// THE OVER-REMOVAL REVERSAL FIX (corrects an earlier version of this
// file): reversing an event must undo its TRUE applied effect on
// inventory, not blindly re-apply the event's own requested `quantity`.
// Those two numbers differ exactly when the original event was a REMOVE
// that got clamped by applyStockEvent.js's over-removal policy — e.g.
// quantity available = 5, REMOVE requests 8, only 5 actually leaves the
// shelf (materialized quantity floors at 0). If a reversal blindly added
// back the requested 8, "undo" would manufacture 3 units of inventory
// that were never real. So createReversalEvent() takes the ACTUAL applied
// quantity as an explicit parameter — it cannot be derived from the event
// alone (the event only ever records what was requested, by design; see
// applyStockEvent.js), so the caller (whoever calls applyStockEvent() in
// the first place) must capture `appliedQuantity` from that call's return
// value at the moment the original event is committed, and pass it
// through when a reversal is later requested. This is the one piece of
// "applied effect" information that has to travel with the event's
// reference from commit-time to reversal-time — it is NOT written onto
// the event itself (events remain immutable/requested-quantity-only); it
// is the caller's job to have it on hand (e.g. a repository storing it
// alongside the event, or a service re-deriving it via
// recomputeQuantityFromEvents() on the events strictly before this one).

import { generateId } from '../shared/ids.js';
import { timestampNow } from '../shared/dates.js';
import { STOCK_EVENT_TYPE } from './stockEventFactory.js';

const OPPOSITE_TYPE = Object.freeze({
  [STOCK_EVENT_TYPE.ADD]: STOCK_EVENT_TYPE.REMOVE,
  [STOCK_EVENT_TYPE.REMOVE]: STOCK_EVENT_TYPE.ADD
});

/**
 * Can this event be reversed right now?
 *
 * An event can be reversed only if it has not ALREADY been reversed
 * (`reversedBy` is null). This is what keeps the reference chain simple:
 * once an event has a reversal, further "undo" of that same original must
 * go through reversing the reversal itself (a fresh call to
 * createReversalEvent() targeting the reversal event), not by attaching a
 * second, competing reversal directly to the original. That would create
 * two reversals pointing at one original with no way to say which one is
 * "the" undo of it.
 *
 * @param {{ reversedBy: string|null }} event
 * @returns {boolean}
 */
export function canBeReversed(event) {
  if (!event || typeof event !== 'object') {
    return false;
  }
  return event.reversedBy === null || event.reversedBy === undefined;
}

/**
 * Build the compensating event for a given stock event, and return both
 * the new reversal event AND the patch to apply to the original event so
 * the two stay linked.
 *
 * Used for BOTH the PRD §14 undo toast and the PRD §15 "reverse this
 * action" history control — there is no separate code path for either.
 * The caller decides *when* to call this (immediately, from a toast
 * timer; or much later, from a history screen); this function itself has
 * no notion of time-since-original and imposes no time limit.
 *
 * @param {object} originalEvent The event being reversed. Must be an
 *   ADD or REMOVE event that has not already been reversed (see
 *   canBeReversed).
 * @param {number} appliedQuantity The ACTUAL quantity that took effect on
 *   inventory when `originalEvent` was originally applied — i.e. the
 *   `appliedQuantity` returned by applyStockEvent() at the moment this
 *   event was committed (see applyStockEvent.js). This is REQUIRED and is
 *   deliberately a separate parameter, not read from
 *   `originalEvent.quantity`: for an ADD, the two are always equal, but
 *   for a REMOVE that was clamped by the over-removal policy,
 *   `appliedQuantity` can be less than `originalEvent.quantity` — and the
 *   reversal must undo the former, not the latter, or "undo" would
 *   fabricate inventory that was never real. Callers that are certain no
 *   clamping occurred (e.g. reversing an ADD, or a REMOVE known to have
 *   been fully satisfied) may simply pass `originalEvent.quantity`.
 *   INVARIANT, ENFORCED HERE (not just trusted from the caller): must
 *   satisfy `0 < appliedQuantity <= originalEvent.quantity`.
 *   `applyStockEvent()` itself guarantees this on its own output, but this
 *   is a public domain boundary and does not assume a caller upheld it —
 *   a too-large `appliedQuantity` is rejected rather than silently
 *   producing an oversized reversal.
 * @returns {{ reversalEvent: object|null, originalPatch: object|null, errors: string[] }}
 *   reversalEvent — the new, opposite-type event, with `reversalOf` set to
 *     `originalEvent.id` and `quantity` set to `appliedQuantity` (NOT
 *     `originalEvent.quantity`). Has its own fresh id and `recordedAt`
 *     (the moment the reversal itself happens — NOT copied from the
 *     original).
 *   originalPatch — `{ reversedBy: reversalEvent.id }`, the ONLY field the
 *     original event's record should be updated with. This is the one
 *     narrow, documented exception to "events are immutable" carried over
 *     from ARCHITECTURE.md's ProductChangeEvent `accepted`-flag exception:
 *     everything else about the original stays exactly as recorded
 *     forever — quantity, cost, comment, purchaseDate, recordedAt are
 *     never touched. Only the backward-reference is added.
 *   errors — non-empty if the event cannot be reversed (wrong shape,
 *     already reversed, or invalid appliedQuantity); reversalEvent/
 *     originalPatch are both null in that case.
 */
export function createReversalEvent(originalEvent, appliedQuantity) {
  const errors = [];

  if (!originalEvent || typeof originalEvent !== 'object') {
    return { reversalEvent: null, originalPatch: null, errors: ['No event to reverse.'] };
  }

  if (
    originalEvent.type !== STOCK_EVENT_TYPE.ADD &&
    originalEvent.type !== STOCK_EVENT_TYPE.REMOVE
  ) {
    errors.push('This event type cannot be reversed.');
  }

  if (
    typeof originalEvent.quantity !== 'number' ||
    !Number.isFinite(originalEvent.quantity) ||
    originalEvent.quantity <= 0
  ) {
    errors.push('This event has no valid quantity to reverse.');
  }

  if (!canBeReversed(originalEvent)) {
    errors.push('This event has already been reversed.');
  }

  if (!originalEvent.id) {
    errors.push('This event has no id to link a reversal to.');
  }

  if (
    typeof appliedQuantity !== 'number' ||
    !Number.isFinite(appliedQuantity) ||
    appliedQuantity <= 0
  ) {
    errors.push('The actual applied quantity for this event is required to reverse it.');
  } else if (
    typeof originalEvent.quantity === 'number' &&
    Number.isFinite(originalEvent.quantity) &&
    appliedQuantity > originalEvent.quantity
  ) {
    // appliedQuantity can be LESS than the requested quantity (a clamped
    // over-removal — see applyStockEvent.js) but can never be MORE than
    // it: applyStockEvent() guarantees appliedQuantity <=
    // event.quantity, and this domain boundary must not trust a caller
    // to have upheld that on its own. Accepting a too-large
    // appliedQuantity here would let a bad caller manufacture a reversal
    // larger than the original event ever was — the exact class of bug
    // this parameter exists to prevent, just moved one level up.
    errors.push('The applied quantity cannot exceed the original event\'s requested quantity.');
  }

  if (errors.length > 0) {
    return { reversalEvent: null, originalPatch: null, errors };
  }

  const reversalEvent = {
    id: generateId(),
    productId: originalEvent.productId,
    type: OPPOSITE_TYPE[originalEvent.type],
    // The reversal undoes the TRUE applied effect, not the requested
    // quantity — see "THE OVER-REMOVAL REVERSAL FIX" above. For an
    // unclamped event these are the same number; for a clamped
    // over-removal, appliedQuantity is the smaller, correct one.
    quantity: appliedQuantity,
    // Cost/purchaseDate are only meaningful for ADD events in the first
    // place (stockEventFactory.js). A reversal of a REMOVE is itself an
    // ADD, but it is not a new purchase — it's compensating for a removal
    // that shouldn't stand — so it deliberately does NOT carry a cost or
    // purchaseDate, even though its type is ADD. Carrying the original
    // REMOVE's (nonexistent) cost forward would be meaningless, and
    // inventing a cost/purchaseDate for it would misrepresent it as a
    // real new stock arrival.
    costPerUnit: null,
    purchaseDate: null,
    recordedAt: timestampNow(),
    comment: `Reversal of previous stock ${originalEvent.type === STOCK_EVENT_TYPE.ADD ? 'addition' : 'removal'}.`,
    reversalOf: originalEvent.id,
    reversedBy: null
  };

  const originalPatch = { reversedBy: reversalEvent.id };

  return { reversalEvent, originalPatch, errors: [] };
}

/**
 * Is this event itself a reversal of some other event?
 *
 * @param {{ reversalOf: string|null }} event
 * @returns {boolean}
 */
export function isReversalEvent(event) {
  return Boolean(event && typeof event === 'object' && event.reversalOf);
}
