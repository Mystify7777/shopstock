// ProductChangeEvent persistence service -- Phase 5F.
//
// Locked write flow (do not reorder -- idempotency before the Product
// lookup, same reasoning as Phase 5E's idempotency-before-concurrency
// ordering: a retry of an already-persisted event must succeed as a
// no-op based on the event's own identity, not fail because some later
// state -- here, whether the referenced Product still exists -- changed
// in between):
//
//   1. validate URL/body identity + static payload shape (done by the
//      caller, via productChangeEventValidation.js, before this
//      function's DB-touching logic runs)
//   2. find existing event by {_id, ownerId}
//        exists -> return existing (200), STOP -- no Product lookup,
//        no insert attempt
//   3. verify referenced Product exists and belongs to this owner
//        missing -> NOT_FOUND
//   4. insert event: ownerId = authenticated user (accepted is NOT stored)
//   5. duplicate-key collision (cross-owner _id) -> CONFLICT
//
// No transaction/session needed -- this is a single-document insert,
// same shape as classificationService.js/productService.js's upserts,
// not a multi-collection operation. The Product lookup in step 3 is
// VALIDATION ONLY, per the locked contract's explicit boundary: this
// service never updates the Product, never compares oldValue/newValue
// against the Product's actual current state, never recomputes or
// second-guesses the change the client already decided. It establishes
// exactly one fact -- this referenced Product exists and belongs to the
// authenticated owner -- and nothing more.

import { AppError } from '../middleware/AppError.js';
import {
  assertIdentityAgreement,
  assertValidProductChangeEventPayload
} from './productChangeEventValidation.js';

const MONGO_DUPLICATE_KEY_ERROR_CODE = 11000;

/**
 * Phase 6E-1d: `accepted` is computed, never stored or client-supplied.
 * An event is accepted iff it is exactly the mutation the Product's
 * server-authoritative LWW state currently records for that field:
 *
 *   event.timestamp === Product.fieldTimestamps[event.field].timestamp
 *   && event.id     === Product.fieldTimestamps[event.field].eventId
 *
 * No Product, no entry, or any mismatch -> false.
 */
export function computeAccepted(event, product) {
  const map = product?.fieldTimestamps;
  const entry = map instanceof Map ? map.get(event.field) : map?.[event.field];
  if (!entry || !entry.timestamp) return false;
  return (
    new Date(entry.timestamp).getTime() === new Date(event.timestamp).getTime() &&
    entry.eventId === event._id
  );
}

// Shape the API response: `_id` stays as-is (existing behavior); any
// legacy stored `accepted` is overwritten by the computed value.
function withAccepted(event, product) {
  return { ...event, accepted: computeAccepted(event, product) };
}

/**
 * @param {import('mongoose').Model} ProductChangeEventModel
 * @param {import('mongoose').Model} ProductModel
 */
export function createProductChangeEventService(ProductChangeEventModel, ProductModel) {
  /**
   * List change events, ownership-scoped, optionally filtered by
   * product, chronological.
   *
   * @param {string} ownerId
   * @param {{ productId?: string }} [options]
   */
  async function list(ownerId, options = {}) {
    const { productId } = options;
    const filter = { ownerId };
    if (productId) filter.productId = productId;
    const events = await ProductChangeEventModel.find(filter).sort({ timestamp: 1 }).lean();
    if (events.length === 0) return [];
    const productIds = [...new Set(events.map((e) => e.productId))];
    const products = await ProductModel.find({ _id: { $in: productIds }, ownerId })
      .select('fieldTimestamps')
      .lean();
    const byId = new Map(products.map((p) => [p._id, p]));
    return events.map((e) => withAccepted(e, byId.get(e.productId)));
  }

  // Read-only Product fetch used ONLY to compute `accepted`. Never
  // throws for a missing Product and never gates idempotency.
  async function findProductForAcceptance(ownerId, productId) {
    return ProductModel.findOne({ _id: productId, ownerId }).select('fieldTimestamps').lean();
  }

  /**
   * Process a ProductChangeEvent: validate, verify the referenced
   * Product exists and is owned by the caller, and persist. Idempotent
   * by event id -- a retried request with the same id and owner returns
   * the already-persisted event without a second insert attempt or a
   * second Product lookup.
   *
   * @param {string} ownerId
   * @param {string} urlId
   * @param {unknown} rawPayload
   * @returns {Promise<object>} the persisted (or already-existing) event
   * @throws {AppError} VALIDATION_ERROR | NOT_FOUND | CONFLICT
   */
  async function processEvent(ownerId, urlId, rawPayload) {
    assertIdentityAgreement(
      urlId,
      rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload) ? rawPayload.id : undefined
    );
    const validated = assertValidProductChangeEventPayload(rawPayload);

    // Step 2 -- idempotency check, FIRST, before the Product lookup.
    const existing = await ProductChangeEventModel.findOne({ _id: urlId, ownerId }).lean();
    if (existing) {
      return withAccepted(existing, await findProductForAcceptance(ownerId, existing.productId));
    }

    // Step 3 -- referenced Product must exist and belong to this owner.
    // Validation only -- see module header. Not scoped inside a
    // transaction with the insert below, since this is a read-then-write
    // sequence against two different collections with no shared
    // atomicity requirement (unlike Phase 5E's Product quantity
    // mutation, nothing here needs to roll back together -- a Product
    // existing at the moment of this check and being deleted a moment
    // later, before the insert below, is not a correctness problem this
    // endpoint needs to solve; Product archival/deletion semantics are
    // handled elsewhere and don't retroactively invalidate historical
    // events).
    const product = await ProductModel.findOne({ _id: validated.productId, ownerId }).lean();
    if (!product) {
      throw new AppError('NOT_FOUND', 'Product not found.');
    }

    const eventDoc = {
      _id: urlId,
      ownerId,
      productId: validated.productId,
      field: validated.field,
      oldValue: validated.oldValue,
      newValue: validated.newValue,
      timestamp: new Date(validated.timestamp)
    };

    try {
      await ProductChangeEventModel.create(eventDoc);
      // Fresh read: the Product snapshot from step 3 may be stale by now
      // (a Product LWW write can land between that read and this insert).
      return withAccepted(eventDoc, await findProductForAcceptance(ownerId, validated.productId));
    } catch (err) {
      if (err && err.code === MONGO_DUPLICATE_KEY_ERROR_CODE) {
        throw new AppError(
          'CONFLICT',
          "This id is already in use by another owner's record."
        );
      }
      throw err;
    }
  }

  return { list, processEvent };
}
