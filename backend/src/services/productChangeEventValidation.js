// ProductChangeEvent payload validation -- Phase 5F.
//
// Pure functions, no DB access -- anything requiring a lookup (Product
// existence/ownership, idempotency) belongs in the service, not here.
// Same separation as stockEventValidation.js.
//
// Field constraints mirror frontend/src/services/productService.js's
// ProductChangeEvent output exactly -- verified against TRACKED_FIELD_MAP
// and buildChangeEvents() before writing this, not re-derived
// independently:
//   - productId: required non-empty string
//   - field: one of the six tracked values (name, category, location,
//     tags, sellingPrice, archived) -- closed enum, matches
//     TRACKED_CHANGE_EVENT_FIELDS in productChangeEventModel.js exactly
//   - oldValue / newValue: required by PRESENCE (Object.hasOwn), not
//     truthiness -- these are legitimately null, false, 0, "", or []
//     depending on field, and this endpoint has no business asserting
//     what a "valid" value looks like for a domain it doesn't own (per
//     the locked contract's explicit boundary: no semantic validation
//     of these values, only presence)
//   - timestamp: required, strictly validated ISO 8601 UTC instant,
//     REUSING isValidTimestamp() from stockEventValidation.js rather
//     than a second implementation -- per the locked contract's
//     explicit instruction not to re-teach JavaScript dates the same
//     lesson twice. Client-generated historical time, validated then
//     preserved unchanged, never regenerated -- same Decision-1
//     reasoning as StockEvent.recordedAt.
//
// Explicitly rejected, always, regardless of value (PRESENCE-based, same
// pattern as every prior slice's server-owned-field guards):
//   - accepted: exclusively server-set to true for this phase. LWW
//     conflict resolution that could someday set this to false is
//     deferred to Phase 6 -- accepting a client-supplied value here,
//     even one that happens to be true, would let the client smuggle
//     a future Phase 6 LWW decision into a phase that doesn't have LWW
//     semantics yet.

import { AppError } from '../middleware/AppError.js';
import { isValidTimestamp } from './stockEventValidation.js';
import { TRACKED_CHANGE_EVENT_FIELDS } from '../models/productChangeEventModel.js';

/**
 * Validate the identity relationship between the URL :id and an optional
 * body.id -- identical rule to every prior slice.
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
 * The accepted-rejection invariant. Checked by PRESENCE, not truthiness
 * -- `{ accepted: true }` is rejected exactly like `{ accepted: false }`,
 * since the point is that the CLIENT never gets to decide this value for
 * this phase, not merely that a "wrong" value is rejected.
 *
 * @throws {AppError} VALIDATION_ERROR
 */
function assertNoAcceptedInPayload(payload) {
  if (Object.hasOwn(payload, 'accepted')) {
    throw new AppError(
      'VALIDATION_ERROR',
      'accepted cannot be submitted by the client. It is always true for ' +
        'events persisted in this phase; LWW resolution is a Phase 6 concern.'
    );
  }
}

/**
 * Validate the full ProductChangeEvent request payload's shape and
 * static field constraints. Does NOT touch the database -- Product
 * existence/ownership verification and idempotency are the service's
 * job, not this module's.
 *
 * @param {unknown} payload
 * @returns {{
 *   productId: string,
 *   field: string,
 *   oldValue: unknown,
 *   newValue: unknown,
 *   timestamp: string
 * }} the validated fields needed by the service
 * @throws {AppError} VALIDATION_ERROR
 */
export function assertValidProductChangeEventPayload(payload) {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new AppError('VALIDATION_ERROR', 'Request body must be an object.');
  }

  assertNoAcceptedInPayload(payload);

  const { productId, field, timestamp } = payload;

  if (typeof productId !== 'string' || productId.trim().length === 0) {
    throw new AppError('VALIDATION_ERROR', 'A change event must be linked to a product.');
  }

  if (!TRACKED_CHANGE_EVENT_FIELDS.includes(field)) {
    throw new AppError(
      'VALIDATION_ERROR',
      `field must be one of: ${TRACKED_CHANGE_EVENT_FIELDS.join(', ')}.`
    );
  }

  if (!Object.hasOwn(payload, 'oldValue')) {
    throw new AppError('VALIDATION_ERROR', 'oldValue is required.');
  }

  if (!Object.hasOwn(payload, 'newValue')) {
    throw new AppError('VALIDATION_ERROR', 'newValue is required.');
  }

  if (!isValidTimestamp(timestamp)) {
    throw new AppError('VALIDATION_ERROR', 'timestamp must be a valid ISO datetime.');
  }

  return {
    productId,
    field,
    oldValue: payload.oldValue,
    newValue: payload.newValue,
    timestamp
  };
}
