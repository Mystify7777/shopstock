// Stock event service.
//
// Orchestration layer between the UI and the domain/stockEventRepository/
// productRepository layers. Owns:
//   - loading the current product internally (callers never pass a Product)
//   - calling domain factories/calculations (createAddStockEvent,
//     createRemoveStockEvent, applyStockEvent, createReversalEvent,
//     canBeReversed, wouldOverRemove, calculateCostProjection)
//   - capturing expectedCurrentQuantity from its own internal read and
//     passing it UNCHANGED to stockEventRepository.commit()/commitReversal()
//   - calling stockEventRepository to persist
//
// Does NOT:
//   - import Dexie or create its own database (receives already-built
//     repositories)
//   - duplicate applyStockEvent()'s clamping math, or reversal.js's
//     reference/quantity logic
//   - modify Product.quantity by any path other than the repository calls
//     below
//   - weaken or replace the repository's own expectedCurrentQuantity
//     consistency check -- this service's preflight guards are ADDITIONAL,
//     not a substitute for it
//
// Error semantics (see docs/PROGRESS.md Phase 3 entry once recorded, and
// the Phase 3 contract this file implements):
//   - domain/input validation failures, and the reversal insufficient-
//     stock preflight guard -> returned as { event: null, errors: [...] },
//     nothing persisted
//   - repository/concurrency failures (QuantityConsistencyError,
//     ProductNotFoundError thrown mid-write, AlreadyReversedError,
//     StockEventNotFoundError, ReversalReferenceError) -> NOT caught here,
//     propagate to the caller, exactly like productService.js already
//     does for productRepository throws
//   - wouldOverRemove()'s own ProductNotFoundError (thrown when the
//     product itself cannot be found) -> also NOT caught here; a boolean
//     return type has no room for a third "unknown" state, so a missing
//     product must not be silently reported as "false, safe to proceed"

import { createAddStockEvent, createRemoveStockEvent } from '../domain/stock/stockEventFactory.js';
import { applyStockEvent, wouldOverRemove as domainWouldOverRemove } from '../domain/stock/applyStockEvent.js';
import { createReversalEvent, canBeReversed } from '../domain/stock/reversal.js';
import { calculateCostProjection } from '../domain/pricing/costCalculations.js';
import { ProductNotFoundError } from '../data/repositories/productRepository.js';

/**
 * Create a stock event service backed by the given repositories.
 *
 * @param {object} stockEventRepository Result of createStockEventRepository(db).
 * @param {object} productRepository    Result of createProductRepository(db).
 */
export function createStockEventService(stockEventRepository, productRepository) {

  /**
   * Return all stock events for a product, in recordedAt order.
   *
   * @param {string} productId
   * @returns {Promise<object[]>}
   */
  async function getHistory(productId) {
    return stockEventRepository.getByProductId(productId);
  }

  /**
   * The most recently recorded cost-per-unit among this product's
   * cost-bearing stock additions, or null if none exist yet.
   *
   * PRD §11.1: the Add Stock form's cost-per-unit field should be
   * prefilled with this value when one exists, and start empty otherwise.
   * This is a thin wrapper around the existing calculateCostProjection() --
   * no new pricing abstraction is introduced.
   *
   * @param {string} productId
   * @returns {Promise<number|null>}
   */
  async function getLatestKnownCost(productId) {
    const events = await stockEventRepository.getByProductId(productId);
    const { latestCost } = calculateCostProjection(events);
    return latestCost;
  }

  /**
   * Would removing `quantity` from this product exceed its current
   * available stock -- i.e. should the UI show the PRD §12 over-removal
   * warning before proceeding?
   *
   * ADVISORY ONLY. This is a preflight UI hint, not a concurrency
   * guarantee -- time can pass between this check and an eventual
   * removeStock() call, during which quantity could change. The
   * repository's own expectedCurrentQuantity check inside commit()'s
   * transaction remains the sole authoritative guard against that gap.
   *
   * Throws ProductNotFoundError (not a silent `false`) if the product
   * does not exist -- a boolean return type has no room to distinguish
   * "false, safe" from "unknown, product missing," so a missing product
   * must not be reported as safe to remove from.
   *
   * @param {string} productId
   * @param {number} quantity
   * @returns {Promise<boolean>}
   * @throws {ProductNotFoundError}
   */
  async function wouldOverRemove(productId, quantity) {
    const product = await productRepository.getById(productId);
    if (!product) {
      throw new ProductNotFoundError(productId);
    }
    return domainWouldOverRemove(product.quantity, {
      type: 'REMOVE',
      quantity
    });
  }

  /**
   * Construct and commit a stock addition.
   *
   * Loads the product internally -- callers never pass a Product object.
   * expectedCurrentQuantity is captured from this internal read and passed
   * UNCHANGED to stockEventRepository.commit(), which re-verifies it
   * against the live DB row inside its own transaction.
   *
   * @param {{ productId: string, quantity: number, costPerUnit?: number|null,
   *   purchaseDate?: string|null, comment?: string }} input
   * @returns {Promise<{ event: object|null, errors: string[] }>}
   *   If errors is non-empty, nothing was persisted.
   * @throws Repository/concurrency errors from stockEventRepository.commit()
   *   (e.g. QuantityConsistencyError, ProductNotFoundError) propagate
   *   uncaught.
   */
  async function addStock({ productId, quantity, costPerUnit, purchaseDate, comment }) {
    const product = await productRepository.getById(productId);
    if (!product) {
      return { event: null, errors: ['Product not found.'] };
    }

    const { event, errors } = createAddStockEvent({
      productId,
      quantity,
      costPerUnit,
      purchaseDate,
      comment
    });

    if (errors.length > 0) {
      return { event: null, errors };
    }

    const expectedCurrentQuantity = product.quantity;
    const { nextQuantity, appliedQuantity } = applyStockEvent(
      product.quantity,
      event
    );

    const persisted = await stockEventRepository.commit({
      event,
      appliedQuantity,
      nextQuantity,
      expectedCurrentQuantity,
      product
    });

    return { event: persisted, errors: [] };
  }

  /**
   * Construct and commit a stock removal.
   *
   * The caller (UI) is responsible for having already called
   * wouldOverRemove() and obtained user confirmation BEFORE calling this
   * -- removeStock() does not re-ask or re-warn; it commits what it is
   * told, exactly matching stockEventFactory.js's own stated design
   * (over-removal warning is a pre-construction UI concern).
   *
   * @param {{ productId: string, quantity: number, comment?: string }} input
   * @returns {Promise<{ event: object|null, errors: string[] }>}
   * @throws Repository/concurrency errors propagate uncaught.
   */
  async function removeStock({ productId, quantity, comment }) {
    const product = await productRepository.getById(productId);
    if (!product) {
      return { event: null, errors: ['Product not found.'] };
    }

    const { event, errors } = createRemoveStockEvent({
      productId,
      quantity,
      comment
    });

    if (errors.length > 0) {
      return { event: null, errors };
    }

    const expectedCurrentQuantity = product.quantity;
    const { nextQuantity, appliedQuantity } = applyStockEvent(
      product.quantity,
      event
    );

    const persisted = await stockEventRepository.commit({
      event,
      appliedQuantity,
      nextQuantity,
      expectedCurrentQuantity,
      product
    });

    return { event: persisted, errors: [] };
  }

  /**
   * Reverse a previously committed stock event (used for both the PRD §14
   * undo toast and the PRD §15 historical reversal control -- same
   * operation, per reversal.js's own documented design).
   *
   * appliedQuantity is read from the STORED event row (persisted at
   * original commit time) -- never recomputed from history.
   *
   * REVERSAL INSUFFICIENT-STOCK GUARD (Option B, per the approved Phase 3
   * contract): if subsequent stock mutations have reduced the product's
   * current quantity below what this reversal would need to remove, the
   * reversal is BLOCKED before any repository call and returned as a
   * validation error. It is never silently clamped -- clamping would
   * produce a partial reversal while presenting it as a full one. This
   * guard reuses the existing, unmodified domain wouldOverRemove()
   * function: once createReversalEvent() builds reversalEvent, its type
   * is already 'REMOVE' whenever the original was an ADD, so the same
   * "would this REMOVE exceed current quantity" question already answers
   * this case generically -- no new domain function was introduced.
   *
   * @param {string} eventId The id of the event to reverse.
   * @returns {Promise<{ event: object|null, errors: string[] }>}
   * @throws Repository/concurrency errors from commitReversal() propagate
   *   uncaught (e.g. a QuantityConsistencyError if quantity changed again
   *   between this function's read and the actual commit).
   */
  async function reverseEvent(eventId) {
    const original = await stockEventRepository.getById(eventId);
    if (!original) {
      return { event: null, errors: ['Stock event not found.'] };
    }

    if (!canBeReversed(original)) {
      return { event: null, errors: ['This event has already been reversed.'] };
    }

    const product = await productRepository.getById(original.productId);
    if (!product) {
      return { event: null, errors: ['Product not found.'] };
    }

    const { reversalEvent, errors } = createReversalEvent(
      original,
      original.appliedQuantity
    );

    if (errors.length > 0) {
      return { event: null, errors };
    }

    // REVERSAL INSUFFICIENT-STOCK GUARD -- see docstring above. Checked
    // BEFORE calling applyStockEvent()/commitReversal() -- nothing is
    // persisted if this trips. Reuses the existing wouldOverRemove(); no
    // new domain surface introduced, applyStockEvent.js/reversal.js
    // untouched.
    if (domainWouldOverRemove(product.quantity, reversalEvent)) {
      return {
        event: null,
        errors: [
          'Cannot reverse: current stock is insufficient to fully ' +
            "restore this event's effect. Reversal was not applied."
        ]
      };
    }

    const expectedCurrentQuantity = product.quantity;
    const { nextQuantity, appliedQuantity } = applyStockEvent(
      product.quantity,
      reversalEvent
    );

    const persisted = await stockEventRepository.commitReversal({
      reversalEvent,
      appliedQuantity,
      originalEventId: original.id,
      nextQuantity,
      expectedCurrentQuantity,
      product
    });

    return { event: persisted, errors: [] };
  }

  return {
    getHistory,
    getLatestKnownCost,
    wouldOverRemove,
    addStock,
    removeStock,
    reverseEvent
  };
}
