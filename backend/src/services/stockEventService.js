// StockEvent transactional service -- Phase 5E, Pass 4.
//
// This is the ONLY backend-controlled path for mutating Product.quantity.
// PUT /api/products/:id explicitly and permanently rejects `quantity` in
// its payload (Phase 5D) -- this file is where that authority actually
// lives.
//
// Locked transaction ordering (do not reorder without re-locking the
// contract -- this exact order was specified because of a real retry-
// breaking bug found during contract review, see the idempotency-first
// rule below):
//
//   BEGIN TRANSACTION
//     1. idempotency check       -- existing StockEvent for {_id, ownerId}?
//                                    YES -> return it immediately, NO
//                                    further checks, NO mutation.
//     2. load owned Product      -- {_id: productId, ownerId}. Missing ->
//                                    NOT_FOUND.
//     3. expectedCurrentQuantity check -- product.quantity must match
//                                    exactly. Mismatch ->
//                                    QUANTITY_CONSISTENCY_CONFLICT.
//     4. reversal validation, if reversalOf is present -- load original,
//        verify ownership, verify not already reversed, verify the
//        SAME productId as the original (a reversal targeting a
//        different product would corrupt the historical relationship
//        between the two events), verify the OPPOSITE type of the
//        original (reversing an ADD must submit REMOVE and vice versa --
//        quantity matching alone is not sufficient, since a same-type
//        "reversal" would double the original movement instead of
//        undoing it), and verify payload.quantity ===
//        original.appliedQuantity (server-derived authority, per the
//        locked contract's Decision 3 -- the client's submitted
//        quantity is validated against, NOT trusted over, the
//        original's stored appliedQuantity). The same-product and
//        opposite-type checks were added after a contract review caught
//        their absence in an earlier version of this file -- both gaps
//        would have let a malformed or malicious "reversal" mutate
//        inventory instead of reversing it.
//     5. compute appliedQuantity + nextQuantity (mirrors
//        applyStockEvent.js exactly -- ADD adds in full; REMOVE clamps
//        at 0 and appliedQuantity may be less than the requested
//        quantity).
//     6. insert StockEvent
//     7. update Product.quantity
//     8. if reversal, patch original.reversedBy
//   COMMIT
//
// WHY idempotency must run first, before the concurrency check: a
// successful request advances product.quantity away from whatever
// expectedCurrentQuantity the client sent. If the client's response was
// lost (network drop, timeout) and it retries with the SAME event id AND
// the SAME (now-stale) expectedCurrentQuantity, checking concurrency
// before idempotency would reject a request that already fully
// succeeded -- punishing the exact retry behavior a reliable client is
// supposed to perform. Checking "does this event already exist" FIRST,
// and returning immediately if so, makes retries safe regardless of how
// stale the retried expectedCurrentQuantity has become.

import mongoose from 'mongoose';
import { AppError } from '../middleware/AppError.js';
import { assertIdentityAgreement, assertValidStockEventPayload } from './stockEventValidation.js';

const MONGO_DUPLICATE_KEY_ERROR_CODE = 11000;

/**
 * Compute appliedQuantity and nextQuantity for a stock event, mirroring
 * frontend/src/domain/stock/applyStockEvent.js exactly:
 *   ADD:    appliedQuantity = quantity;            nextQuantity = current + quantity
 *   REMOVE: appliedQuantity = min(quantity, current); nextQuantity = max(current - quantity, 0)
 *
 * REMOVE never drives nextQuantity negative, and appliedQuantity can be
 * LESS than the requested quantity when the removal exceeds what's
 * available -- this is the exact value that must be captured at this
 * moment, since it cannot be reconstructed later from the event alone.
 *
 * @param {'ADD'|'REMOVE'} type
 * @param {number} quantity requested quantity (event.quantity)
 * @param {number} currentQuantity product.quantity before this event
 * @returns {{ appliedQuantity: number, nextQuantity: number }}
 */
function computeQuantityMutation(type, quantity, currentQuantity) {
  if (type === 'ADD') {
    return {
      appliedQuantity: quantity,
      nextQuantity: currentQuantity + quantity
    };
  }
  // REMOVE
  const appliedQuantity = Math.min(quantity, currentQuantity);
  return {
    appliedQuantity,
    nextQuantity: currentQuantity - appliedQuantity
  };
}

/**
 * @param {import('mongoose').Model} StockEventModel
 * @param {import('mongoose').Model} ProductModel
 */
export function createStockEventService(StockEventModel, ProductModel) {
  /**
   * List stock events for a product, ownership-scoped, chronological.
   *
   * @param {string} ownerId
   * @param {{ productId?: string, includeReversed?: boolean }} options
   */
  async function list(ownerId, options = {}) {
    const { productId, includeReversed = true } = options;
    const filter = { ownerId };
    if (productId) filter.productId = productId;
    // includeReversed defaults to true because a reversed event is still
    // a real historical fact (PRD Section 13/15: history must never be
    // silently hidden, only ever compensated by a new event) -- unlike
    // "archived" on Product/classifications, "reversed" is not a
    // visibility toggle, so there is no includeReversed=false-by-default
    // convention to mirror here.
    if (includeReversed === false) filter.reversedBy = null;
    return StockEventModel.find(filter).sort({ recordedAt: 1 }).lean();
  }

  /**
   * Process a StockEvent: validate, enforce ownership + optimistic
   * concurrency, apply the quantity mutation, and persist the event
   * alongside the updated Product, all in one transaction. Idempotent by
   * event id -- a retried request with the same id and owner returns the
   * already-persisted event without mutating quantity a second time.
   *
   * @param {string} ownerId
   * @param {string} urlId
   * @param {unknown} rawPayload
   * @returns {Promise<object>} the persisted (or already-existing) event
   * @throws {AppError} VALIDATION_ERROR | NOT_FOUND |
   *   QUANTITY_CONSISTENCY_CONFLICT | ALREADY_REVERSED | CONFLICT
   */
  async function processEvent(ownerId, urlId, rawPayload) {
    assertIdentityAgreement(urlId, rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload) ? rawPayload.id : undefined);
    const validated = assertValidStockEventPayload(rawPayload);

    const session = await mongoose.startSession();
    try {
      let result;

      await session.withTransaction(async () => {
        // Step 1 -- idempotency check, FIRST, before anything else that
        // could reject a request whose effects already committed.
        const existing = await StockEventModel.findOne(
          { _id: urlId, ownerId },
          null,
          { session }
        ).lean();
        if (existing) {
          result = existing;
          return; // no further checks, no mutation -- genuine no-op retry
        }

        // Step 2 -- load owned Product.
        const product = await ProductModel.findOne(
          { _id: validated.productId, ownerId },
          null,
          { session }
        ).lean();
        if (!product) {
          throw new AppError('NOT_FOUND', 'Product not found.');
        }

        // Step 3 -- optimistic concurrency.
        if (product.quantity !== validated.expectedCurrentQuantity) {
          throw new AppError(
            'QUANTITY_CONSISTENCY_CONFLICT',
            `Expected current quantity ${validated.expectedCurrentQuantity}, ` +
              `but the product's actual quantity is ${product.quantity}.`
          );
        }

        // Step 4 -- reversal validation, if applicable. Server-derived
        // authority: the original's stored appliedQuantity is what gets
        // validated against, not merely referenced -- see the module
        // header and the locked contract's Decision 3.
        //
        // Three separate invariants are enforced here, all required for
        // a reversal to actually BE a reversal rather than an
        // unrelated event that happens to reference another one's id:
        //   (a) same product -- a reversal that targets a DIFFERENT
        //       product than the original event would mutate the wrong
        //       product's inventory while marking the original's
        //       reversedBy, corrupting the historical relationship
        //       between the two events (caught in review; there was no
        //       check for this at all originally).
        //   (b) opposite type -- reversing an ADD must submit a REMOVE,
        //       and vice versa, mirroring reversal.js's own domain
        //       contract exactly (createReversalEvent() always flips
        //       the type). Checking quantity alone is NOT sufficient: a
        //       same-type "reversal" with a matching quantity would
        //       silently double the original movement instead of
        //       undoing it -- caught in review; there was no check for
        //       this at all originally, and it is arguably the more
        //       dangerous of the two gaps, since it directly
        //       manufactures or destroys inventory rather than merely
        //       misattributing it to the wrong product.
        //   (c) quantity equals the original's appliedQuantity -- see
        //       above, already present.
        let originalEvent = null;
        if (validated.reversalOf) {
          originalEvent = await StockEventModel.findOne(
            { _id: validated.reversalOf, ownerId },
            null,
            { session }
          ).lean();
          if (!originalEvent) {
            throw new AppError('NOT_FOUND', 'The event being reversed was not found.');
          }
          if (originalEvent.reversedBy != null) {
            throw new AppError('ALREADY_REVERSED', 'This event has already been reversed.');
          }
          if (originalEvent.productId !== validated.productId) {
            throw new AppError(
              'VALIDATION_ERROR',
              'A reversal must belong to the same product as the original event.'
            );
          }
          const expectedReversalType = originalEvent.type === 'ADD' ? 'REMOVE' : 'ADD';
          if (validated.type !== expectedReversalType) {
            throw new AppError(
              'VALIDATION_ERROR',
              `A reversal of an ${originalEvent.type} event must be ` +
                `${expectedReversalType}, not ${validated.type}.`
            );
          }
          if (validated.quantity !== originalEvent.appliedQuantity) {
            throw new AppError(
              'VALIDATION_ERROR',
              `A reversal's quantity must equal the original event's applied ` +
                `quantity (${originalEvent.appliedQuantity}), not the requested ` +
                `value (${validated.quantity}).`
            );
          }
        }

        // Step 5 -- compute the mutation.
        const { appliedQuantity, nextQuantity } = computeQuantityMutation(
          validated.type,
          validated.quantity,
          product.quantity
        );

        const eventDoc = {
          _id: urlId,
          ownerId,
          productId: validated.productId,
          type: validated.type,
          quantity: validated.quantity,
          appliedQuantity,
          costPerUnit: validated.costPerUnit,
          purchaseDate: validated.purchaseDate,
          recordedAt: new Date(validated.recordedAt),
          comment: validated.comment,
          reversalOf: validated.reversalOf,
          reversedBy: null
        };

        // Step 6 -- insert StockEvent. A cross-owner _id collision
        // surfaces here as a duplicate-key error, caught below and
        // translated to CONFLICT, same pattern as every prior slice.
        await StockEventModel.create([eventDoc], { session });

        // Step 7 -- update Product.quantity. Scoped to {_id, ownerId}
        // exactly like every other write in this project -- this is
        // belt-and-suspenders here since step 2 already proved
        // ownership, but the write itself stays self-defending rather
        // than relying solely on an earlier read. matchedCount is
        // checked explicitly rather than assumed: for code whose entire
        // purpose is atomic inventory correctness, a silent zero-match
        // write should fail loudly, not be quietly trusted because the
        // read a moment earlier happened to succeed.
        const productUpdate = await ProductModel.updateOne(
          { _id: validated.productId, ownerId },
          { $set: { quantity: nextQuantity } },
          { session }
        );
        if (productUpdate.matchedCount !== 1) {
          throw new AppError('NOT_FOUND', 'Product not found.');
        }

        // Step 8 -- patch the original event's reversedBy, if this was
        // a reversal. The ONE mutation ever made to an existing
        // stock-event document, per reversal.js's domain contract.
        // Same matchedCount discipline as the product update above.
        if (originalEvent) {
          const reversalUpdate = await StockEventModel.updateOne(
            { _id: originalEvent._id, ownerId },
            { $set: { reversedBy: urlId } },
            { session }
          );
          if (reversalUpdate.matchedCount !== 1) {
            throw new AppError('NOT_FOUND', 'The event being reversed was not found.');
          }
        }

        result = eventDoc;
      });

      return result;
    } catch (err) {
      if (err && err.code === MONGO_DUPLICATE_KEY_ERROR_CODE) {
        throw new AppError(
          'CONFLICT',
          "This id is already in use by another owner's record."
        );
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }

  return { list, processEvent };
}
