// Stock-history DISPLAY helpers (Phase 7E). Pure; no React, no IndexedDB.
//
// These only decide how already-recorded events are ordered and described
// for the product detail page. They do not compute quantities, decide
// reversal eligibility (domain/stock/reversal.js: canBeReversed), or change
// anything about the events. History stays the honest record the
// repository returns.

import {
  formatDateOnlyForDisplay,
  formatTimestampForDisplay,
  isValidDateOnly,
  isValidTimestamp
} from '../shared/dates.js';

/**
 * Order history newest first for display.
 *
 * stockEventService.getHistory() returns events in recordedAt ASCENDING
 * order. This is a STABLE descending sort on recordedAt: events with the
 * same recordedAt keep the relative order the service gave them (no id-based
 * tie-breaker is invented -- two events recorded in the same millisecond
 * have no meaningful order beyond what the service returned). An event with
 * no usable recordedAt sorts after every event that has one, and keeps its
 * relative order among its peers.
 *
 * @param {object[]} events As returned by stockEventService.getHistory().
 * @returns {object[]} A NEW array; the input is not modified.
 * @throws {TypeError} If events is not an array.
 */
export function orderHistoryNewestFirst(events) {
  if (!Array.isArray(events)) {
    throw new TypeError('orderHistoryNewestFirst requires an array of events.');
  }

  const has = (event) => typeof event.recordedAt === 'string' && event.recordedAt !== '';

  // Array.prototype.sort is stable, so a 0 result preserves service order.
  return [...events].sort((a, b) => {
    const aHas = has(a);
    const bHas = has(b);
    if (aHas && bHas) {
      if (a.recordedAt > b.recordedAt) return -1;
      if (a.recordedAt < b.recordedAt) return 1;
      return 0;
    }
    if (aHas !== bHas) return aHas ? -1 : 1;
    return 0;
  });
}

/**
 * Describe one stored stock event for display, using only fields the event
 * actually carries. Nothing is invented: a missing field becomes null.
 *
 * `amount` is what actually changed the product's quantity -- for a REMOVE
 * clamped at zero (over-removal) that is appliedQuantity, not the requested
 * quantity. Rows without appliedQuantity fall back to the requested one.
 *
 * @param {object} event
 * @returns {{
 *   direction: 'added' | 'removed',
 *   amount: number,
 *   requested: number,
 *   wasClamped: boolean,
 *   comment: string | null,
 *   isReversal: boolean,
 *   isReversed: boolean,
 *   recordedAt: string | null,
 *   purchaseDate: string | null,
 *   costPerUnit: number | null | undefined
 * }}
 *   costPerUnit is only meaningful for additions: null means "an addition
 *   with no recorded cost", and it is undefined for a removal.
 */
export function describeHistoryEntry(event) {
  const isAdd = event.type === 'ADD';
  const requested = event.quantity;
  const amount =
    typeof event.appliedQuantity === 'number' && Number.isFinite(event.appliedQuantity)
      ? event.appliedQuantity
      : requested;

  return {
    direction: isAdd ? 'added' : 'removed',
    amount,
    requested,
    wasClamped: !isAdd && amount < requested,
    comment: typeof event.comment === 'string' && event.comment.trim() !== '' ? event.comment : null,
    isReversal: typeof event.reversalOf === 'string' && event.reversalOf !== '',
    isReversed: typeof event.reversedBy === 'string' && event.reversedBy !== '',
    recordedAt: isValidTimestamp(event.recordedAt) ? event.recordedAt : null,
    purchaseDate: isAdd && isValidDateOnly(event.purchaseDate) ? event.purchaseDate : null,
    costPerUnit: isAdd
      ? typeof event.costPerUnit === 'number' && Number.isFinite(event.costPerUnit)
        ? event.costPerUnit
        : null
      : undefined
  };
}

/** "09 Aug 2026, 3:42 PM" for a valid timestamp; null otherwise (never throws). */
export function formatEntryTime(recordedAt) {
  return isValidTimestamp(recordedAt) ? formatTimestampForDisplay(recordedAt) : null;
}

/** "09 Aug 2026" for a valid date-only value; null otherwise (never throws). */
export function formatEntryDate(dateOnly) {
  return isValidDateOnly(dateOnly) ? formatDateOnlyForDisplay(dateOnly) : null;
}
