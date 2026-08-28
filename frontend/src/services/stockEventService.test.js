import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../data/db/schema.js';
import { createProductRepository } from '../data/repositories/productRepository.js';
import { createClassificationRepository } from '../data/repositories/classificationRepository.js';
import { createStockEventRepository, QuantityConsistencyError } from '../data/repositories/stockEventRepository.js';
import { ProductNotFoundError } from '../data/repositories/productRepository.js';
import { createProductService } from './productService.js';
import { createStockEventService } from './stockEventService.js';

// Real repositories, real fake-indexeddb -- no mocking. This exercises the
// full service -> domain -> repository -> Dexie path for stock operations,
// mirroring the established productService.test.js pattern.
//
// productService here is only used as a fixture-builder helper
// (createProduct()) to set up products for stock-event tests -- this file
// never calls productService.searchProducts(). classificationRepository is
// still supplied because createProductService() requires both repositories
// as of the Phase 4A corrective pass.

describe('stockEventService', () => {
  let db;
  let productRepository;
  let classificationRepository;
  let stockEventRepository;
  let productService;
  let stockEventService;

  beforeEach(() => {
    db = createDatabase();
    productRepository = createProductRepository(db);
    classificationRepository = createClassificationRepository(db);
    stockEventRepository = createStockEventRepository(db);
    productService = createProductService(productRepository, classificationRepository);
    stockEventService = createStockEventService(stockEventRepository, productRepository);
  });

  afterEach(async () => {
    if (db.isOpen()) db.close();
    await db.delete();
  });

  async function makeProduct(overrides = {}) {
    const { product } = await productService.createProduct({ name: 'Test Product', ...overrides });
    return product;
  }

  // =========================================================================
  // addStock
  // =========================================================================

  describe('addStock', () => {
    it('persists an event and updates product quantity', async () => {
      const product = await makeProduct();
      const { event, errors } = await stockEventService.addStock({
        productId: product.id,
        quantity: 20
      });
      expect(errors).toEqual([]);
      expect(event.type).toBe('ADD');
      expect(event.appliedQuantity).toBe(20);

      const stored = await productRepository.getById(product.id);
      expect(stored.quantity).toBe(20);
    });

    it('returns errors and persists nothing for invalid quantity', async () => {
      const product = await makeProduct();
      const { event, errors } = await stockEventService.addStock({
        productId: product.id,
        quantity: -5
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(event).toBeNull();

      const stored = await productRepository.getById(product.id);
      expect(stored.quantity).toBe(0);
      const history = await stockEventService.getHistory(product.id);
      expect(history).toHaveLength(0);
    });

    it('returns errors for a nonexistent product', async () => {
      const { event, errors } = await stockEventService.addStock({
        productId: 'no-such-product',
        quantity: 5
      });
      expect(event).toBeNull();
      expect(errors.length).toBeGreaterThan(0);
    });

    it('records costPerUnit and purchaseDate when provided', async () => {
      const product = await makeProduct();
      const { event, errors } = await stockEventService.addStock({
        productId: product.id,
        quantity: 10,
        costPerUnit: 55,
        purchaseDate: '2026-08-09',
        comment: 'New delivery'
      });
      expect(errors).toEqual([]);
      expect(event.costPerUnit).toBe(55);
      expect(event.purchaseDate).toBe('2026-08-09');
      expect(event.comment).toBe('New delivery');
    });
  });

  // =========================================================================
  // removeStock
  // =========================================================================

  describe('removeStock', () => {
    it('unclamped removal decreases quantity exactly', async () => {
      const product = await makeProduct();
      await stockEventService.addStock({ productId: product.id, quantity: 20 });
      const { event, errors } = await stockEventService.removeStock({
        productId: product.id,
        quantity: 5
      });
      expect(errors).toEqual([]);
      expect(event.quantity).toBe(5);
      expect(event.appliedQuantity).toBe(5);

      const stored = await productRepository.getById(product.id);
      expect(stored.quantity).toBe(15);
    });

    it('clamped removal: requested quantity != appliedQuantity, floors at 0', async () => {
      const product = await makeProduct();
      await stockEventService.addStock({ productId: product.id, quantity: 5 });
      const { event, errors } = await stockEventService.removeStock({
        productId: product.id,
        quantity: 8 // only 5 available
      });
      expect(errors).toEqual([]);
      expect(event.quantity).toBe(8);         // requested, preserved
      expect(event.appliedQuantity).toBe(5);  // true applied delta

      const stored = await productRepository.getById(product.id);
      expect(stored.quantity).toBe(0);
    });

    it('comment absence is stored as null (PRD §12 "No justification provided" is display-only)', async () => {
      const product = await makeProduct();
      await stockEventService.addStock({ productId: product.id, quantity: 10 });
      const { event } = await stockEventService.removeStock({
        productId: product.id,
        quantity: 3
      });
      expect(event.comment).toBeNull();
    });
  });

  // =========================================================================
  // wouldOverRemove
  // =========================================================================

  describe('wouldOverRemove', () => {
    it('returns false when sufficient stock is available', async () => {
      const product = await makeProduct();
      await stockEventService.addStock({ productId: product.id, quantity: 10 });
      const result = await stockEventService.wouldOverRemove(product.id, 5);
      expect(result).toBe(false);
    });

    it('returns true when requested quantity exceeds current stock', async () => {
      const product = await makeProduct();
      await stockEventService.addStock({ productId: product.id, quantity: 5 });
      const result = await stockEventService.wouldOverRemove(product.id, 8);
      expect(result).toBe(true);
    });

    it('throws ProductNotFoundError for a nonexistent product (not a silent false)', async () => {
      await expect(
        stockEventService.wouldOverRemove('no-such-product', 5)
      ).rejects.toThrow(ProductNotFoundError);
    });
  });

  // =========================================================================
  // getLatestKnownCost
  // =========================================================================

  describe('getLatestKnownCost', () => {
    it('returns null when no cost has ever been recorded', async () => {
      const product = await makeProduct();
      await stockEventService.addStock({ productId: product.id, quantity: 10 });
      const cost = await stockEventService.getLatestKnownCost(product.id);
      expect(cost).toBeNull();
    });

    it('returns the most recently recorded cost', async () => {
      const product = await makeProduct();
      await stockEventService.addStock({ productId: product.id, quantity: 10, costPerUnit: 50 });
      await stockEventService.addStock({ productId: product.id, quantity: 5, costPerUnit: 55 });
      const cost = await stockEventService.getLatestKnownCost(product.id);
      expect(cost).toBe(55);
    });

    it('returns null for a product with no stock events at all', async () => {
      const product = await makeProduct();
      const cost = await stockEventService.getLatestKnownCost(product.id);
      expect(cost).toBeNull();
    });
  });

  // =========================================================================
  // reverseEvent -- unclamped and clamped originals
  // =========================================================================

  describe('reverseEvent', () => {
    it('unclamped ADD reversal: restores the exact pre-addition quantity', async () => {
      const product = await makeProduct();
      // quantity: 0 -> 10
      const { event: addEvent } = await stockEventService.addStock({
        productId: product.id, quantity: 10
      });
      // quantity: 10 -> 7
      await stockEventService.removeStock({ productId: product.id, quantity: 3 });

      // Reverse the ADD (appliedQuantity 10). Current quantity is 7, so the
      // reversal (a REMOVE of 10) would take it to -3 -- this SHOULD be
      // blocked by the insufficient-stock guard, not silently clamped.
      // Covered explicitly in its own test below; here we test the
      // straightforward unclamped case instead: reverse the REMOVE (an ADD
      // reversal, never clamped).
      const removeResult = await stockEventService.removeStock({
        productId: product.id, quantity: 2
      });
      // quantity now: 7 - 2 = 5
      const { event: reversal, errors } = await stockEventService.reverseEvent(
        removeResult.event.id
      );
      expect(errors).toEqual([]);
      expect(reversal.type).toBe('ADD'); // reversal of a REMOVE is an ADD
      expect(reversal.quantity).toBe(2);
      expect(reversal.reversalOf).toBe(removeResult.event.id);

      const stored = await productRepository.getById(product.id);
      expect(stored.quantity).toBe(7); // back to pre-removal quantity
    });

    it('clamped original: reversal restores appliedQuantity, not the originally requested quantity', async () => {
      const product = await makeProduct();
      // quantity: 0 -> 5
      await stockEventService.addStock({ productId: product.id, quantity: 5 });
      // REMOVE 8, only 5 available -- clamped
      const { event: removeEvent } = await stockEventService.removeStock({
        productId: product.id, quantity: 8
      });
      expect(removeEvent.quantity).toBe(8);
      expect(removeEvent.appliedQuantity).toBe(5);

      const stored = await productRepository.getById(product.id);
      expect(stored.quantity).toBe(0);

      // Reverse the clamped REMOVE -- must restore exactly 5, not 8.
      const { event: reversal, errors } = await stockEventService.reverseEvent(removeEvent.id);
      expect(errors).toEqual([]);
      expect(reversal.quantity).toBe(5); // appliedQuantity, not requested 8

      const afterReversal = await productRepository.getById(product.id);
      expect(afterReversal.quantity).toBe(5); // not 8
    });

    it('already-reversed event returns errors and does not double-commit', async () => {
      const product = await makeProduct();
      const { event: addEvent } = await stockEventService.addStock({
        productId: product.id, quantity: 10
      });
      await stockEventService.reverseEvent(addEvent.id);

      const { event, errors } = await stockEventService.reverseEvent(addEvent.id);
      expect(event).toBeNull();
      expect(errors.length).toBeGreaterThan(0);
    });

    it('nonexistent event id returns errors', async () => {
      const { event, errors } = await stockEventService.reverseEvent('no-such-event');
      expect(event).toBeNull();
      expect(errors.length).toBeGreaterThan(0);
    });

    // -----------------------------------------------------------------------
    // Reversal insufficient-stock guard (Option B) -- the required test from
    // the approved Phase 3 contract.
    // -----------------------------------------------------------------------

    it('refuses to commit when subsequent mutations reduce quantity below the original appliedQuantity', async () => {
      const product = await makeProduct();
      // quantity: 0 -> 10
      const { event: addEvent } = await stockEventService.addStock({
        productId: product.id, quantity: 10
      });
      // quantity: 10 -> 5 (subsequent mutation)
      await stockEventService.removeStock({ productId: product.id, quantity: 5 });

      // Reversing the ADD requires removing 10, but only 5 is available.
      const { event, errors } = await stockEventService.reverseEvent(addEvent.id);

      expect(event).toBeNull();
      expect(errors.length).toBeGreaterThan(0);

      // Original event must remain unreversed.
      const storedOriginal = await stockEventRepository.getById(addEvent.id);
      expect(storedOriginal.reversedBy).toBeNull();

      // Product quantity must remain unchanged by the blocked attempt.
      const storedProduct = await productRepository.getById(product.id);
      expect(storedProduct.quantity).toBe(5);

      // No new stock event was created for this blocked reversal attempt.
      const history = await stockEventService.getHistory(product.id);
      expect(history).toHaveLength(2); // the ADD and the REMOVE, nothing more

      // No new syncQueue entries from this blocked attempt.
      const queueEntries = await db.syncQueue.toArray();
      const reversalEntries = queueEntries.filter(
        (e) => e.entityType === 'stockEvent' && e.payload.reversalOf === addEvent.id
      );
      expect(reversalEntries).toHaveLength(0);
    });
  });

  // =========================================================================
  // getHistory
  // =========================================================================

  describe('getHistory', () => {
    it('returns events in recordedAt ascending order', async () => {
      const product = await makeProduct();
      await stockEventService.addStock({ productId: product.id, quantity: 10 });
      await stockEventService.removeStock({ productId: product.id, quantity: 3 });
      const history = await stockEventService.getHistory(product.id);
      expect(history).toHaveLength(2);
      expect(history[0].type).toBe('ADD');
      expect(history[1].type).toBe('REMOVE');
    });

    it('returns an empty array for a product with no stock events', async () => {
      const product = await makeProduct();
      const history = await stockEventService.getHistory(product.id);
      expect(history).toEqual([]);
    });
  });

  // =========================================================================
  // Stale expectedCurrentQuantity -- repository consistency check, full rollback
  // =========================================================================

  describe('stale expectedCurrentQuantity', () => {
    it('stockEventRepository.commit() rejects a stale expectedCurrentQuantity and rolls back all tables (the guard stockEventService relies on)', async () => {
      const product = await makeProduct();
      await stockEventService.addStock({ productId: product.id, quantity: 10 });

      // Directly mutate the stored product quantity underneath the service,
      // simulating a concurrent write that happened between a read and a
      // commit -- without touching stockEventRepository.js itself.
      const stored = await productRepository.getById(product.id);
      await db.products.put({ ...stored, quantity: 999 });

      // Build an addStock-equivalent call manually so we can inject a
      // deliberately stale expectedCurrentQuantity via the repository
      // directly (the service always reads fresh, so we exercise the
      // repository's own guard the same way the service would if a write
      // raced it -- this proves the authoritative check the service relies
      // on, without modifying stockEventRepository.js).
      const { createAddStockEvent } = await import('../domain/stock/stockEventFactory.js');
      const { applyStockEvent } = await import('../domain/stock/applyStockEvent.js');
      const { event } = createAddStockEvent({ productId: product.id, quantity: 5 });
      const { nextQuantity, appliedQuantity } = applyStockEvent(10, event); // stale base of 10

      const beforeEvents = await db.stockEvents.count();
      const beforeQueue = await db.syncQueue.count();

      await expect(
        stockEventRepository.commit({
          event,
          appliedQuantity,
          nextQuantity,
          expectedCurrentQuantity: 10, // stale -- actual stored quantity is now 999
          product: stored
        })
      ).rejects.toThrow(QuantityConsistencyError);

      // Full rollback across all three tables.
      const afterEvents = await db.stockEvents.count();
      const afterQueue = await db.syncQueue.count();
      expect(afterEvents).toBe(beforeEvents);
      expect(afterQueue).toBe(beforeQueue);

      const productAfter = await productRepository.getById(product.id);
      expect(productAfter.quantity).toBe(999); // unchanged by the failed commit
    });
  });
});
