// StockEvent payload validation -- Phase 5E, Pass 3 (model + validation
// only; transactional processing and quantity mutation are Pass 4's job,
// in stockEventService.js, not here).
//
// These functions validate SHAPE and STATIC field constraints only --
// anything requiring a database lookup (product ownership/existence,
// expectedCurrentQuantity match, reversal-target existence/already-
// reversed/appliedQuantity check, idempotency) is explicitly OUT OF
// SCOPE here and belongs in the transactional service, since those
// checks only make sense inside the transaction's consistent view of
// the data (see the locked Phase 5E contract's transaction ordering:
// idempotency check first, then product load, then
// expectedCurrentQuantity, then reversal validation, all inside one
// session).
//
// Field constraints mirror frontend/src/domain/stock/stockEventFactory.js
// exactly -- verified against createAddStockEvent(), createRemoveStockEvent(),
// and isValidStockEventShape() before writing this, not re-derived
// independently:
//   - type: 'ADD' | 'REMOVE' only
//   - quantity: finite number > 0
//   - costPerUnit: ADD only; REJECTED BY PRESENCE on REMOVE (including
//     an explicit `costPerUnit: null` -- the key existing on the payload
//     at all is invalid for a REMOVE, not just a meaningful non-null
//     value); if present on ADD, must be a finite number >= 0 (not just
//     "a number" -- negative cost is invalid, matching the factory)
//   - purchaseDate: ADD only; REJECTED BY PRESENCE on REMOVE, same rule
//     as costPerUnit; if present on ADD, must be a valid real calendar
//     date, strictly validated (YYYY-MM-DD, round-trip-checked against
//     Date.UTC() so e.g. "2026-02-31" is rejected outright rather than
//     silently rolling over to "2026-03-03")
//   - recordedAt: required, strictly validated against the exact ISO
//     8601 UTC-instant pattern the client's timestampNow() produces
//     (not merely "does `new Date()` manage to parse it somehow" --
//     freeform strings and malformed/incomplete timestamps are
//     rejected), TRUSTED from the client per the locked Phase 5E
//     contract's Decision 1 -- validated, then returned completely
//     unmodified, never regenerated, never trimmed (a whitespace-
//     bearing value fails the strict pattern match outright rather than
//     being silently trimmed and accepted, since timestamps are
//     protocol values, not user-entered prose)
//   - comment: optional string; empty/absent normalizes to null,
//     mirroring normalizeComment()'s behavior
//   - expectedCurrentQuantity: required, finite number >= 0
//   - reversalOf: optional string (event id) or null/absent for an
//     ordinary event
//
// Explicitly rejected, always, regardless of value (PRESENCE-based,
// same pattern as productService.js's assertNoQuantityInPayload /
// assertNoChangeEventsInPayload):
//   - appliedQuantity: exclusively server-computed at commit time; a
//     client-supplied value here is not merely redundant, it's the
//     exact number this project's own domain rules say can only be
//     known at the moment of application -- accepting a client value
//     would silently reopen the cross-device inflation bug documented
//     in HANDOFF.md and ARCHITECTURE.md's appliedQuantity amendment

import { AppError } from '../middleware/AppError.js';

const STOCK_EVENT_TYPES = ['ADD', 'REMOVE'];

// Ported directly from frontend/src/domain/shared/dates.js's own patterns
// and validators -- NOT independently re-derived -- per the review
// finding that `new Date(value)` alone is too permissive to honestly be
// called "ISO validation" (it accepts freeform strings like "September 2,
// 2026" and silently rolls over impossible calendar dates like
// "2026-02-31" into "2026-03-03" instead of rejecting them). The client
// already solved both problems correctly; mirroring it here is more
// correct than inventing a second, possibly-different strictness level.
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Validate the identity relationship between the URL :id and an optional
 * body.id -- identical rule to every prior slice (classificationService.js,
 * productService.js).
 *
 * @throws {AppError} VALIDATION_ERROR
 */
export function assertIdentityAgreement(urlId, bodyId) {
  if (bodyId === undefined) return;
  if (bodyId === urlId) return;
  throw new AppError(
    'VALIDATION_ERROR',
    `Request body id ("${bodyId}") does not match the URL id ("${urlId}").`
  );
}

/**
 * The appliedQuantity-rejection invariant. Checked by PRESENCE, not
 * truthiness -- `{ appliedQuantity: 0 }` is rejected exactly like any
 * other value, same pattern as the Phase 5D quantity/changeEvents
 * invariants.
 *
 * @throws {AppError} VALIDATION_ERROR
 */
function assertNoAppliedQuantityInPayload(payload) {
  if (Object.hasOwn(payload, 'appliedQuantity')) {
    throw new AppError(
      'VALIDATION_ERROR',
      'appliedQuantity cannot be submitted by the client. It is computed ' +
        'server-side at the moment a stock event is applied.'
    );
  }
}

/**
 * Is this a well-formed timestamp string, matching what the client's
 * `timestampNow()` produces (full ISO 8601 UTC instant with milliseconds
 * and a literal 'Z', e.g. "2026-09-02T14:30:00.000Z")? Anchored pattern
 * match FIRST, then a parse check as a secondary guard -- a string that
 * merely "looks like a date to `new Date()`" (e.g. "September 2, 2026",
 * or a timestamp missing the 'Z'/milliseconds) is rejected even though
 * `new Date()` alone would happily parse it. No leading/trailing
 * whitespace is tolerated -- timestamps are protocol values generated by
 * the client's own `timestampNow()`, not user-entered prose, so a
 * whitespace-bearing value is rejected outright rather than trimmed and
 * silently accepted.
 */
function isValidTimestamp(value) {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) {
    return false;
  }
  return !Number.isNaN(new Date(value).getTime());
}

/**
 * Is this a well-formed date-only string ("YYYY-MM-DD") representing a
 * REAL calendar date? Rejects e.g. "2026-02-31" outright, rather than
 * letting `new Date()` silently roll it over to "2026-03-03" -- the
 * round-trip check (reconstruct the date from its parsed UTC components
 * and confirm they still match what was supplied) is what catches this;
 * pattern-matching the shape alone is not sufficient, since
 * "9999-99-99"-shaped nonsense like "2026-02-31" still matches
 * \d{4}-\d{2}-\d{2}.
 */
function isValidDateOnly(value) {
  if (typeof value !== 'string' || !DATE_ONLY_PATTERN.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

/**
 * Validate the full StockEvent request payload's shape and static field
 * constraints. Does NOT touch the database -- see the module header for
 * what's deliberately out of scope here.
 *
 * @param {unknown} payload
 * @returns {{
 *   productId: string,
 *   type: 'ADD'|'REMOVE',
 *   quantity: number,
 *   costPerUnit: number|null,
 *   purchaseDate: string|null,
 *   recordedAt: string,
 *   comment: string|null,
 *   reversalOf: string|null,
 *   expectedCurrentQuantity: number
 * }} the validated, normalized fields needed by the service
 * @throws {AppError} VALIDATION_ERROR
 */
export function assertValidStockEventPayload(payload) {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AppError('VALIDATION_ERROR', 'Request body must be an object.');
  }

  assertNoAppliedQuantityInPayload(payload);

  const { productId, type, quantity, costPerUnit, purchaseDate, recordedAt, comment, reversalOf, expectedCurrentQuantity } = payload;

  if (typeof productId !== 'string' || productId.trim().length === 0) {
    throw new AppError('VALIDATION_ERROR', 'A stock event must be linked to a product.');
  }

  if (!STOCK_EVENT_TYPES.includes(type)) {
    throw new AppError('VALIDATION_ERROR', "type must be 'ADD' or 'REMOVE'.");
  }

  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) {
    throw new AppError('VALIDATION_ERROR', 'quantity must be a number greater than 0.');
  }

  if (typeof expectedCurrentQuantity !== 'number' || !Number.isFinite(expectedCurrentQuantity) || expectedCurrentQuantity < 0) {
    throw new AppError('VALIDATION_ERROR', 'expectedCurrentQuantity must be a non-negative number.');
  }

  if (!isValidTimestamp(recordedAt)) {
    throw new AppError('VALIDATION_ERROR', 'recordedAt must be a valid ISO datetime.');
  }

  // costPerUnit / purchaseDate: ADD-only, mirroring
  // createRemoveStockEvent()'s signature deliberately having no such
  // parameters at all -- a REMOVE payload that includes either is a
  // call-site error, not a silent no-op, same philosophy the client
  // domain layer already applies.
  //
  // Presence is checked BEFORE the ADD/REMOVE branch, and rejects a
  // REMOVE payload that includes the key at all -- including an explicit
  // `costPerUnit: null` or `purchaseDate: null` -- not just a meaningful
  // non-null value. The locked contract's wording is "if present on
  // REMOVE -> VALIDATION_ERROR", and presence means the key exists on
  // the object, independent of what it's set to; an earlier version of
  // this function only rejected non-null values on REMOVE, which is a
  // materially looser contract than what was actually locked.
  if (type === 'REMOVE' && Object.hasOwn(payload, 'costPerUnit')) {
    throw new AppError('VALIDATION_ERROR', 'costPerUnit is only valid for ADD events.');
  }
  if (type === 'REMOVE' && Object.hasOwn(payload, 'purchaseDate')) {
    throw new AppError('VALIDATION_ERROR', 'purchaseDate is only valid for ADD events.');
  }

  let normalizedCostPerUnit = null;
  if (Object.hasOwn(payload, 'costPerUnit') && costPerUnit !== null) {
    if (typeof costPerUnit !== 'number' || !Number.isFinite(costPerUnit) || costPerUnit < 0) {
      throw new AppError('VALIDATION_ERROR', 'costPerUnit must be a non-negative number, or left blank.');
    }
    normalizedCostPerUnit = costPerUnit;
  }

  let normalizedPurchaseDate = null;
  if (Object.hasOwn(payload, 'purchaseDate') && purchaseDate !== null) {
    if (!isValidDateOnly(purchaseDate)) {
      throw new AppError('VALIDATION_ERROR', 'purchaseDate is not a valid date.');
    }
    normalizedPurchaseDate = purchaseDate;
  }

  let normalizedComment = null;
  if (Object.hasOwn(payload, 'comment') && comment !== null) {
    if (typeof comment !== 'string') {
      throw new AppError('VALIDATION_ERROR', 'comment must be a string or null.');
    }
    const trimmed = comment.trim();
    normalizedComment = trimmed.length > 0 ? trimmed : null;
  }

  let normalizedReversalOf = null;
  if (Object.hasOwn(payload, 'reversalOf') && reversalOf !== null) {
    if (typeof reversalOf !== 'string' || reversalOf.trim().length === 0) {
      throw new AppError('VALIDATION_ERROR', 'reversalOf must be a non-empty string or null.');
    }
    normalizedReversalOf = reversalOf;
  }

  return {
    productId,
    type,
    quantity,
    costPerUnit: normalizedCostPerUnit,
    purchaseDate: normalizedPurchaseDate,
    recordedAt,
    comment: normalizedComment,
    reversalOf: normalizedReversalOf,
    expectedCurrentQuantity
  };
}
