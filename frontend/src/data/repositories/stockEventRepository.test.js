import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../db/schema.js';
import {
  createStockEventRepository,
  InvalidStockEventError,
  InvalidProductError,
  ProductNotFoundError,
  StockEventNotFoundError,
  QuantityConsistencyError,
  AlreadyReversedError,
  ReversalReferenceError,
} from './stockEventRepository.js';
import { createProduct } from '../../domain/product/productFactory.js';
import {
  createAddStockEvent,
  createRemoveStockEvent,
} from '../../domain/stock/stockEventFactory.js';
import { applyStockEvent } from '../../domain/stock/applyStockEvent.js';
import { createReversalEvent } from '../../domain/stock/reversal.js';
import { createSyncRequest } from '../sync/syncRequest.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a valid product via the domain factory. */
function makeProduct(overrides = {}) {
  const { product } = createProduct({ name: 'Test Product', ...overrides });
  return product;
}

/**
 * Build a valid ADD stock event via the domain factory.
 * productId must match the product being committed against.
 */
function makeAddEvent(productId, qty = 10) {
  const { event } = createAddStockEvent({ productId, quantity: qty });
  return event;
}

/**
 * Build a valid REMOVE stock event via the domain factory.
 */
function makeRemoveEvent(productId, qty = 3) {
  const { event } = createRemoveStockEvent({ productId, quantity: qty });
  return event;
}

/**
 * Helper: seed the DB with a product and optionally a committed stock event.
 * Returns { product, storedEvent } where storedEvent may be null.
 *
 * This bypasses the repository under test for the seeding step so tests
 * can establish known state without depending on commit() itself.
 */
async function seedProduct(db, overrides = {}) {
  const product = makeProduct(overrides);
  await db.products.add(product);
  return product;
}

/**
 * Helper: commit a stock event through the repository and return the
 * inputs used, so subsequent tests have a consistent starting point.
 */
async function commitAddEvent(repo, product, qty = 10) {
  const event = makeAddEvent(product.id, qty);
  const { nextQuantity, appliedQuantity } = applyStockEvent(product.quantity, event);
  await repo.commit({
    event,
    appliedQuantity,
    nextQuantity,
    expectedCurrentQuantity: product.quantity,
    product,
  });
  // Return the updated product state for chaining
  return { event, appliedQuantity, nextQuantity, updatedProduct: { ...product, quantity: nextQuantity } };
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

describe('stockEventRepository', () => {
  let db;
  let repo;

  beforeEach(() => {
    db   = createDatabase();
    repo = createStockEventRepository(db);
  });

  afterEach(async () => {
    if (db.isOpen()) db.close();
    await db.delete();
  });

  // =========================================================================
  // getById
  // =========================================================================

  describe('getById', () => {
    it('returns undefined for a non-existent id', async () => {
      expect(await repo.getById('no-such-event')).toBeUndefined();
    });

    it('returns the persisted row including appliedQuantity after commit', async () => {
      const product = await seedProduct(db);
      const { event, appliedQuantity } = await commitAddEvent(repo, product, 10);
      const row = await repo.getById(event.id);
      expect(row).toBeDefined();
      expect(row.id).toBe(event.id);
      expect(row.appliedQuantity).toBe(appliedQuantity);
    });

    it('returned row includes domain fields alongside appliedQuantity', async () => {
      const product = await seedProduct(db);
      const { event } = await commitAddEvent(repo, product, 5);
      const row = await repo.getById(event.id);
      expect(row.type).toBe('ADD');
      expect(row.quantity).toBe(5);
      expect(row.productId).toBe(product.id);
      expect(typeof row.recordedAt).toBe('string');
    });
  });

  // =========================================================================
  // getByProductId
  // =========================================================================

  describe('getByProductId', () => {
    it('returns empty array when no events exist for the product', async () => {
      const product = await seedProduct(db);
      expect(await repo.getByProductId(product.id)).toEqual([]);
    });

    it('returns events for the correct product only', async () => {
      const p1 = await seedProduct(db, { name: 'P1' });
      const p2 = await seedProduct(db, { name: 'P2' });
      await commitAddEvent(repo, p1, 5);
      expect(await repo.getByProductId(p2.id)).toHaveLength(0);
    });

    it('returns multiple events in recordedAt ascending order', async () => {
      const product = await seedProduct(db);
      // Commit two events; even if they get the same ms timestamp in tests,
      // the order in the DB must be stable ascending.
      const { updatedProduct } = await commitAddEvent(repo, product, 10);
      const removeEvent = makeRemoveEvent(product.id, 3);
      const { nextQuantity: nq, appliedQuantity: aq } =
        applyStockEvent(updatedProduct.quantity, removeEvent);
      await repo.commit({
        event: removeEvent,
        appliedQuantity: aq,
        nextQuantity: nq,
        expectedCurrentQuantity: updatedProduct.quantity,
        product: updatedProduct,
      });
      const rows = await repo.getByProductId(product.id);
      expect(rows).toHaveLength(2);
      expect(rows[0].type).toBe('ADD');
      expect(rows[1].type).toBe('REMOVE');
    });
  });

  // =========================================================================
  // commit — input validation
  // =========================================================================

  describe('commit — input validation', () => {
    it('throws InvalidStockEventError for null event', async () => {
      const product = await seedProduct(db);
      await expect(
        repo.commit({ event: null, appliedQuantity: 5, nextQuantity: 5,
          expectedCurrentQuantity: 0, product })
      ).rejects.toThrow(InvalidStockEventError);
    });

    it('throws InvalidStockEventError for event missing id', async () => {
      const product = await seedProduct(db);
      await expect(
        repo.commit({ event: { type: 'ADD', quantity: 5 }, appliedQuantity: 5,
          nextQuantity: 5, expectedCurrentQuantity: 0, product })
      ).rejects.toThrow(InvalidStockEventError);
    });

    it('throws InvalidProductError for null product', async () => {
      const product = await seedProduct(db);
      const event = makeAddEvent(product.id, 5);
      await expect(
        repo.commit({ event, appliedQuantity: 5, nextQuantity: 5,
          expectedCurrentQuantity: 0, product: null })
      ).rejects.toThrow(InvalidProductError);
    });

    it('throws ProductNotFoundError when product does not exist in DB', async () => {
      const product = makeProduct(); // not seeded into DB
      const event = makeAddEvent(product.id, 5);
      await expect(
        repo.commit({ event, appliedQuantity: 5, nextQuantity: 5,
          expectedCurrentQuantity: 0, product })
      ).rejects.toThrow(ProductNotFoundError);
    });
  });

  // =========================================================================
  // commit — quantity consistency invariant
  // =========================================================================

  describe('commit — quantity consistency', () => {
    it('throws QuantityConsistencyError when expectedCurrentQuantity is stale', async () => {
      const product = await seedProduct(db);
      const event = makeAddEvent(product.id, 5);
      // Pass wrong expectedCurrentQuantity (product has 0, we claim 99)
      await expect(
        repo.commit({
          event,
          appliedQuantity: 5,
          nextQuantity: 104,
          expectedCurrentQuantity: 99,   // stale / wrong
          product,
        })
      ).rejects.toThrow(QuantityConsistencyError);
    });

    it('leaves the database completely unchanged after a stale quantity rejection', async () => {
      const product = await seedProduct(db);
      const event = makeAddEvent(product.id, 5);
      await expect(
        repo.commit({
          event, appliedQuantity: 5, nextQuantity: 104,
          expectedCurrentQuantity: 99, product,
        })
      ).rejects.toThrow(QuantityConsistencyError);

      // stockEvents untouched
      expect(await db.stockEvents.get(event.id)).toBeUndefined();
      // product quantity unchanged
      const storedProduct = await db.products.get(product.id);
      expect(storedProduct.quantity).toBe(0);
      // syncQueue empty
      expect(await db.syncQueue.toArray()).toHaveLength(0);
    });
  });

  // =========================================================================
  // commit — happy path persistence
  // =========================================================================

  describe('commit — persistence', () => {
    it('persists the event row with appliedQuantity', async () => {
      const product = await seedProduct(db);
      const event = makeAddEvent(product.id, 10);
      const { nextQuantity, appliedQuantity } = applyStockEvent(product.quantity, event);
      await repo.commit({ event, appliedQuantity, nextQuantity,
        expectedCurrentQuantity: product.quantity, product });

      const row = await db.stockEvents.get(event.id);
      expect(row).toBeDefined();
      expect(row.appliedQuantity).toBe(appliedQuantity);
      expect(row.quantity).toBe(10);  // domain quantity unchanged
    });

    it('updates the product materialized quantity', async () => {
      const product = await seedProduct(db);
      const event = makeAddEvent(product.id, 10);
      const { nextQuantity, appliedQuantity } = applyStockEvent(product.quantity, event);
      await repo.commit({ event, appliedQuantity, nextQuantity,
        expectedCurrentQuantity: product.quantity, product });

      const stored = await db.products.get(product.id);
      expect(stored.quantity).toBe(10);
    });

    it('clamped over-removal: stores event.quantity=8, appliedQuantity=5, product.quantity=0', async () => {
      // Seed product with quantity 5 directly
      const product = makeProduct();
      await db.products.add({ ...product, quantity: 5 });
      const seededProduct = { ...product, quantity: 5 };

      const event = makeRemoveEvent(product.id, 8); // remove 8, only 5 available
      const { nextQuantity, appliedQuantity } =
        applyStockEvent(seededProduct.quantity, event);

      expect(appliedQuantity).toBe(5);  // clamped
      expect(nextQuantity).toBe(0);

      await repo.commit({
        event, appliedQuantity, nextQuantity,
        expectedCurrentQuantity: seededProduct.quantity,
        product: seededProduct,
      });

      const storedEvent = await db.stockEvents.get(event.id);
      expect(storedEvent.quantity).toBe(8);           // requested quantity preserved
      expect(storedEvent.appliedQuantity).toBe(5);    // true applied delta persisted

      const storedProduct = await db.products.get(product.id);
      expect(storedProduct.quantity).toBe(0);
    });

    it('returns the persisted row (domain fields + appliedQuantity)', async () => {
      const product = await seedProduct(db);
      const event = makeAddEvent(product.id, 7);
      const { nextQuantity, appliedQuantity } = applyStockEvent(product.quantity, event);
      const result = await repo.commit({
        event, appliedQuantity, nextQuantity,
        expectedCurrentQuantity: product.quantity, product,
      });
      expect(result.id).toBe(event.id);
      expect(result.appliedQuantity).toBe(appliedQuantity);
    });
  });

  // =========================================================================
  // commit — sync queue entries
  // =========================================================================

  describe('commit — sync queue', () => {
    it('enqueues exactly two sync entries', async () => {
      const product = await seedProduct(db);
      const event = makeAddEvent(product.id, 10);
      const { nextQuantity, appliedQuantity } = applyStockEvent(product.quantity, event);
      await repo.commit({ event, appliedQuantity, nextQuantity,
        expectedCurrentQuantity: product.quantity, product });

      const entries = await db.syncQueue.toArray();
      expect(entries).toHaveLength(2);
    });

    it('stockEvent sync entry has correct shape including appliedQuantity in payload', async () => {
      const product = await seedProduct(db);
      const event = makeAddEvent(product.id, 10);
      const { nextQuantity, appliedQuantity } = applyStockEvent(product.quantity, event);
      await repo.commit({ event, appliedQuantity, nextQuantity,
        expectedCurrentQuantity: product.quantity, product });

      const entry = (await db.syncQueue.toArray())
        .find(e => e.entityType === 'stockEvent');
      expect(entry).toBeDefined();
      expect(entry.operation).toBe('insert');
      expect(entry.entityId).toBe(event.id);
      expect(entry.clientId).toBe(event.id);   // insert: clientId === entityId
      expect(entry.payload.appliedQuantity).toBe(appliedQuantity);  // MANDATORY
      expect(entry.payload.id).toBe(event.id);
      expect(entry.status).toBe('pending');
      expect(entry.attempts).toBe(0);
      expect(entry.lastError).toBeNull();
    });

    it('stockEvent sync entry payload contains the exact expectedCurrentQuantity observed at commit time', async () => {
      // This is the producer-boundary guarantee: expectedCurrentQuantity
      // must be captured from the Product.quantity this operation was
      // actually committed against, and persisted verbatim into the
      // queued payload -- not left absent, and not something a later
      // sync step would need to (re-)derive.
      const product = await seedProduct(db, { quantity: 12 });
      const event = makeAddEvent(product.id, 10);
      const { nextQuantity, appliedQuantity } = applyStockEvent(product.quantity, event);
      await repo.commit({
        event,
        appliedQuantity,
        nextQuantity,
        expectedCurrentQuantity: product.quantity,
        product,
      });

      const entry = (await db.syncQueue.toArray())
        .find(e => e.entityType === 'stockEvent');
      expect(entry.payload.expectedCurrentQuantity).toBe(12);
    });

    it('stockEvent sync entry payload retains appliedQuantity alongside expectedCurrentQuantity', async () => {
      // Both fields must coexist in the queue payload -- one is the
      // storage-layer field needed for a later local/cross-device
      // reversal, the other is the backend's required consistency
      // check on the wire. Stripping appliedQuantity for transport is
      // createSyncRequest()'s job (see the pipeline test below), not
      // something the queue producer should do.
      const product = await seedProduct(db, { quantity: 7 });
      const event = makeAddEvent(product.id, 3);
      const { nextQuantity, appliedQuantity } = applyStockEvent(product.quantity, event);
      await repo.commit({
        event,
        appliedQuantity,
        nextQuantity,
        expectedCurrentQuantity: product.quantity,
        product,
      });

      const entry = (await db.syncQueue.toArray())
        .find(e => e.entityType === 'stockEvent');
      expect(entry.payload.appliedQuantity).toBe(appliedQuantity);
      expect(entry.payload.expectedCurrentQuantity).toBe(7);
    });

    it('reversal sync entry payload also contains the expectedCurrentQuantity observed at reversal-commit time', async () => {
      // Same producer-boundary guarantee applies to commitReversal(),
      // which shares buildStockEventSyncEntry() with commit().
      //
      // Uses a genuine over-removal: 5 available, REMOVE 8 requested, so
      // appliedQuantity clamps to 5 (matching the documented reversal
      // invariant 0 < appliedQuantity <= originalEvent.quantity) rather
      // than a degenerate all-the-way-to-zero case.
      const product = await seedProduct(db, { quantity: 5 });
      const original = makeRemoveEvent(product.id, 8); // over-removal: clamps to 5
      const { appliedQuantity: originalApplied, nextQuantity: afterRemoval } =
        applyStockEvent(product.quantity, original);
      await repo.commit({
        event: original,
        appliedQuantity: originalApplied,
        nextQuantity: afterRemoval,
        expectedCurrentQuantity: product.quantity,
        product,
      });

      const productAfterRemoval = { ...product, quantity: afterRemoval };
      const { reversalEvent, errors } = createReversalEvent(original, originalApplied);
      expect(errors).toEqual([]);
      const { appliedQuantity: reversalApplied, nextQuantity: reversalNext } =
        applyStockEvent(productAfterRemoval.quantity, reversalEvent);

      await repo.commitReversal({
        reversalEvent,
        appliedQuantity: reversalApplied,
        originalEventId: original.id,
        nextQuantity: reversalNext,
        expectedCurrentQuantity: productAfterRemoval.quantity,
        product: productAfterRemoval,
      });

      const reversalEntry = (await db.syncQueue.toArray())
        .filter(e => e.entityType === 'stockEvent')
        .find(e => e.entityId === reversalEvent.id);
      expect(reversalEntry.payload.expectedCurrentQuantity).toBe(afterRemoval);
      expect(reversalEntry.payload.appliedQuantity).toBe(reversalApplied);
    });

    it('full producer-to-wire pipeline: the real queued payload survives createSyncRequest() with expectedCurrentQuantity preserved and appliedQuantity stripped', async () => {
      // This is the end-to-end proof the Phase 6A review specifically
      // asked for: not a hand-built fixture payload, but the ACTUAL
      // queue entry produced by a real commit(), fed through the real
      // createSyncRequest() translator.
      const product = await seedProduct(db, { quantity: 20 });
      const event = makeAddEvent(product.id, 5);
      const { nextQuantity, appliedQuantity } = applyStockEvent(product.quantity, event);
      await repo.commit({
        event,
        appliedQuantity,
        nextQuantity,
        expectedCurrentQuantity: product.quantity,
        product,
      });

      const queuedEntry = (await db.syncQueue.toArray())
        .find(e => e.entityType === 'stockEvent');

      const { body } = createSyncRequest(queuedEntry);

      expect(body.expectedCurrentQuantity).toBe(20);
      expect(Object.hasOwn(body, 'appliedQuantity')).toBe(false);
    });

    it('product sync entry has correct shape with fresh clientId', async () => {
      const product = await seedProduct(db);
      const event = makeAddEvent(product.id, 10);
      const { nextQuantity, appliedQuantity } = applyStockEvent(product.quantity, event);
      await repo.commit({ event, appliedQuantity, nextQuantity,
        expectedCurrentQuantity: product.quantity, product });

      const entry = (await db.syncQueue.toArray())
        .find(e => e.entityType === 'product');
      expect(entry).toBeDefined();
      expect(entry.operation).toBe('upsert');
      expect(entry.entityId).toBe(product.id);
      expect(entry.clientId).not.toBe(product.id);  // fresh per mutation
      expect(entry.payload.quantity).toBe(nextQuantity);
    });

    it('two commits to same product produce different product sync clientIds', async () => {
      const product = await seedProduct(db);
      const { updatedProduct } = await commitAddEvent(repo, product, 10);
      await commitAddEvent(repo, updatedProduct, 5);

      const productEntries = (await db.syncQueue.toArray())
        .filter(e => e.entityType === 'product');
      expect(productEntries).toHaveLength(2);
      expect(productEntries[0].entityId).toBe(product.id);
      expect(productEntries[1].entityId).toBe(product.id);
      expect(productEntries[0].clientId).not.toBe(productEntries[1].clientId);
    });

    it('stockEvent sync entry clientId equals entityId equals event.id', async () => {
      const product = await seedProduct(db);
      const event = makeAddEvent(product.id, 10);
      const { nextQuantity, appliedQuantity } = applyStockEvent(product.quantity, event);
      await repo.commit({ event, appliedQuantity, nextQuantity,
        expectedCurrentQuantity: product.quantity, product });

      const entry = (await db.syncQueue.toArray())
        .find(e => e.entityType === 'stockEvent');
      expect(entry.entityId).toBe(event.id);
      expect(entry.clientId).toBe(event.id);
      expect(entry.entityId).toBe(entry.clientId);
    });
  });

  // =========================================================================
  // commit — atomicity / rollback tests
  //
  // Inject failure at each write position and verify the COMPLETE pre-call
  // state is preserved across all three tables.
  // =========================================================================

  describe('commit — atomicity', () => {
    async function runCommitAttempt(db, repo) {
      const product = await seedProduct(db);
      const event = makeAddEvent(product.id, 10);
      const { nextQuantity, appliedQuantity } = applyStockEvent(product.quantity, event);
      return {
        product, event, appliedQuantity, nextQuantity,
        doCommit: () => repo.commit({
          event, appliedQuantity, nextQuantity,
          expectedCurrentQuantity: product.quantity, product,
        }),
      };
    }

    async function assertCleanState(db, product, event) {
      expect(await db.stockEvents.get(event.id)).toBeUndefined();
      const stored = await db.products.get(product.id);
      expect(stored.quantity).toBe(product.quantity);  // unchanged
      expect(await db.syncQueue.toArray()).toHaveLength(0);
    }

    it('rolls back all writes when stockEvents.add fails', async () => {
      const { product, event, doCommit } = await runCommitAttempt(db, repo);

      const orig = db.stockEvents.add.bind(db.stockEvents);
      db.stockEvents.add = async () => { throw new Error('forced stockEvents failure'); };
      await expect(doCommit()).rejects.toThrow('forced stockEvents failure');
      db.stockEvents.add = orig;

      await assertCleanState(db, product, event);
    });

    it('rolls back all writes when products.put fails', async () => {
      const { product, event, doCommit } = await runCommitAttempt(db, repo);

      const orig = db.products.put.bind(db.products);
      db.products.put = async () => { throw new Error('forced products failure'); };
      await expect(doCommit()).rejects.toThrow('forced products failure');
      db.products.put = orig;

      await assertCleanState(db, product, event);
    });

    it('rolls back all writes when the stockEvent syncQueue entry write fails', async () => {
      const { product, event, doCommit } = await runCommitAttempt(db, repo);

      // syncQueue.add is called twice: stockEvent first, then product.
      // Fail on the first call.
      let callCount = 0;
      const orig = db.syncQueue.add.bind(db.syncQueue);
      db.syncQueue.add = async (entry) => {
        callCount++;
        if (callCount === 1) throw new Error('forced syncQueue stockEvent failure');
        return orig(entry);
      };
      await expect(doCommit()).rejects.toThrow('forced syncQueue stockEvent failure');
      db.syncQueue.add = orig;

      await assertCleanState(db, product, event);
    });

    it('rolls back all writes when the product syncQueue entry write fails', async () => {
      const { product, event, doCommit } = await runCommitAttempt(db, repo);

      // Fail on the second syncQueue.add call (the product upsert entry).
      let callCount = 0;
      const orig = db.syncQueue.add.bind(db.syncQueue);
      db.syncQueue.add = async (entry) => {
        callCount++;
        if (callCount === 2) throw new Error('forced syncQueue product failure');
        return orig(entry);
      };
      await expect(doCommit()).rejects.toThrow('forced syncQueue product failure');
      db.syncQueue.add = orig;

      await assertCleanState(db, product, event);
    });
  });

  // =========================================================================
  // commitReversal — input validation
  // =========================================================================

  describe('commitReversal — input validation', () => {
    it('throws InvalidStockEventError for null reversalEvent', async () => {
      const product = await seedProduct(db);
      await expect(
        repo.commitReversal({
          reversalEvent: null, appliedQuantity: 5, originalEventId: 'orig-id',
          nextQuantity: 0, expectedCurrentQuantity: 0, product,
        })
      ).rejects.toThrow(InvalidStockEventError);
    });

    it('throws InvalidStockEventError for non-string originalEventId', async () => {
      const product = await seedProduct(db);
      const reversalEvent = { id: 'rev-id', reversalOf: 'orig-id' };
      await expect(
        repo.commitReversal({
          reversalEvent, appliedQuantity: 5, originalEventId: 42,
          nextQuantity: 5, expectedCurrentQuantity: 0, product,
        })
      ).rejects.toThrow(InvalidStockEventError);
    });

    it('throws ReversalReferenceError when reversalEvent.reversalOf !== originalEventId — without touching DB', async () => {
      const product = await seedProduct(db);
      const reversalEvent = { id: 'rev-id', reversalOf: 'WRONG-ID' };
      const originalEventId = 'correct-id';

      await expect(
        repo.commitReversal({
          reversalEvent, appliedQuantity: 5, originalEventId,
          nextQuantity: 5, expectedCurrentQuantity: 0, product,
        })
      ).rejects.toThrow(ReversalReferenceError);

      // Verify no DB access occurred — the error must be thrown before the
      // transaction opens, not after attempting reads.
      expect(await db.stockEvents.toArray()).toHaveLength(0);
      expect(await db.syncQueue.toArray()).toHaveLength(0);
    });

    it('throws StockEventNotFoundError when original event does not exist in DB', async () => {
      const product = await seedProduct(db);
      const reversalEvent = { id: 'rev-id', reversalOf: 'nonexistent-orig' };
      await expect(
        repo.commitReversal({
          reversalEvent, appliedQuantity: 5, originalEventId: 'nonexistent-orig',
          nextQuantity: 5, expectedCurrentQuantity: 0, product,
        })
      ).rejects.toThrow(StockEventNotFoundError);
    });

    it('throws AlreadyReversedError when original event already has reversedBy set', async () => {
      const product = await seedProduct(db);
      const { event, updatedProduct } = await commitAddEvent(repo, product, 10);

      // Build a valid reversal and commit it
      const stored = await repo.getById(event.id);
      const { reversalEvent } = createReversalEvent(event, stored.appliedQuantity);
      const { nextQuantity: nq, appliedQuantity: aq } =
        applyStockEvent(updatedProduct.quantity, reversalEvent);
      await repo.commitReversal({
        reversalEvent, appliedQuantity: aq, originalEventId: event.id,
        nextQuantity: nq, expectedCurrentQuantity: updatedProduct.quantity,
        product: updatedProduct,
      });

      // Now try to reverse the original again — already reversed
      const secondReversal = {
        id: 'second-rev', reversalOf: event.id, type: 'REMOVE',
        quantity: aq, recordedAt: new Date().toISOString(),
        productId: product.id, costPerUnit: null, purchaseDate: null,
        comment: null, reversedBy: null,
      };
      const productAfterReversal = await db.products.get(product.id);
      await expect(
        repo.commitReversal({
          reversalEvent: secondReversal, appliedQuantity: aq,
          originalEventId: event.id,
          nextQuantity: productAfterReversal.quantity - aq,
          expectedCurrentQuantity: productAfterReversal.quantity,
          product: productAfterReversal,
        })
      ).rejects.toThrow(AlreadyReversedError);
    });

    it('rejects with AlreadyReversedError when storedOriginal.reversedBy is undefined (not just null)', async () => {
      // undefined must not be treated as the valid unreversed state.
      // The invariant is strictly reversedBy === null.
      const product = await seedProduct(db);
      const { event, updatedProduct } = await commitAddEvent(repo, product, 10);

      // Directly corrupt the stored row so reversedBy is undefined
      const stored = await db.stockEvents.get(event.id);
      const { reversedBy, ...withoutReversedBy } = stored;
      await db.stockEvents.put(withoutReversedBy);

      const { reversalEvent } = createReversalEvent(stored, stored.appliedQuantity);
      const { nextQuantity, appliedQuantity } =
        applyStockEvent(updatedProduct.quantity, reversalEvent);

      await expect(
        repo.commitReversal({
          reversalEvent, appliedQuantity, originalEventId: event.id,
          nextQuantity, expectedCurrentQuantity: updatedProduct.quantity,
          product: updatedProduct,
        })
      ).rejects.toThrow(AlreadyReversedError);
    });
  });

  // =========================================================================
  // commitReversal — quantity consistency
  // =========================================================================

  describe('commitReversal — quantity consistency', () => {
    it('throws QuantityConsistencyError when expectedCurrentQuantity is stale', async () => {
      const product = await seedProduct(db);
      const { event, updatedProduct } = await commitAddEvent(repo, product, 10);
      const stored = await repo.getById(event.id);
      const { reversalEvent } = createReversalEvent(event, stored.appliedQuantity);
      const { nextQuantity, appliedQuantity } =
        applyStockEvent(updatedProduct.quantity, reversalEvent);

      await expect(
        repo.commitReversal({
          reversalEvent, appliedQuantity, originalEventId: event.id,
          nextQuantity, expectedCurrentQuantity: 999,  // stale
          product: updatedProduct,
        })
      ).rejects.toThrow(QuantityConsistencyError);
    });
  });

  // =========================================================================
  // commitReversal — happy path persistence
  // =========================================================================

  describe('commitReversal — persistence', () => {
    async function setupReversal(db, repo) {
      const product = await seedProduct(db);
      const { event, appliedQuantity: origApplied, nextQuantity: afterAdd, updatedProduct } =
        await commitAddEvent(repo, product, 10);
      const stored = await repo.getById(event.id);
      const { reversalEvent } = createReversalEvent(stored, stored.appliedQuantity);
      const { nextQuantity, appliedQuantity } =
        applyStockEvent(updatedProduct.quantity, reversalEvent);
      return {
        product, updatedProduct, event, stored,
        reversalEvent, appliedQuantity, nextQuantity,
        afterAdd,
      };
    }

    it('persists the reversal event row with appliedQuantity', async () => {
      const { updatedProduct, event, reversalEvent, appliedQuantity, nextQuantity } =
        await setupReversal(db, repo);
      await repo.commitReversal({
        reversalEvent, appliedQuantity, originalEventId: event.id,
        nextQuantity, expectedCurrentQuantity: updatedProduct.quantity,
        product: updatedProduct,
      });
      const row = await db.stockEvents.get(reversalEvent.id);
      expect(row).toBeDefined();
      expect(row.appliedQuantity).toBe(appliedQuantity);
      expect(row.reversalOf).toBe(event.id);
    });

    it('patches reversedBy on the original event', async () => {
      const { updatedProduct, event, reversalEvent, appliedQuantity, nextQuantity } =
        await setupReversal(db, repo);
      await repo.commitReversal({
        reversalEvent, appliedQuantity, originalEventId: event.id,
        nextQuantity, expectedCurrentQuantity: updatedProduct.quantity,
        product: updatedProduct,
      });
      const original = await db.stockEvents.get(event.id);
      expect(original.reversedBy).toBe(reversalEvent.id);
    });

    it('updates the product materialized quantity', async () => {
      const { updatedProduct, event, reversalEvent, appliedQuantity, nextQuantity } =
        await setupReversal(db, repo);
      await repo.commitReversal({
        reversalEvent, appliedQuantity, originalEventId: event.id,
        nextQuantity, expectedCurrentQuantity: updatedProduct.quantity,
        product: updatedProduct,
      });
      const stored = await db.products.get(updatedProduct.id);
      expect(stored.quantity).toBe(nextQuantity);
    });

    it('reversal of clamped over-removal restores to true applied amount, not requested', async () => {
      // Product starts with 5 units
      const product = makeProduct();
      await db.products.add({ ...product, quantity: 5 });
      const seededProduct = { ...product, quantity: 5 };

      // Remove 8 (clamped to 5, quantity goes to 0)
      const removeEvent = makeRemoveEvent(product.id, 8);
      const { nextQuantity: afterRemove, appliedQuantity: removeApplied } =
        applyStockEvent(seededProduct.quantity, removeEvent);
      expect(removeApplied).toBe(5);
      expect(afterRemove).toBe(0);

      const removedProduct = { ...seededProduct, quantity: afterRemove };
      await repo.commit({
        event: removeEvent, appliedQuantity: removeApplied,
        nextQuantity: afterRemove, expectedCurrentQuantity: seededProduct.quantity,
        product: removedProduct,
      });

      // Reverse the clamped removal — must restore 5, not 8
      const storedRemove = await repo.getById(removeEvent.id);
      expect(storedRemove.appliedQuantity).toBe(5);

      const { reversalEvent } = createReversalEvent(storedRemove, storedRemove.appliedQuantity);
      expect(reversalEvent.quantity).toBe(5);  // reversal uses appliedQuantity

      const { nextQuantity: afterReversal, appliedQuantity: revApplied } =
        applyStockEvent(removedProduct.quantity, reversalEvent);
      expect(afterReversal).toBe(5);  // restored to true pre-removal state, not 8

      await repo.commitReversal({
        reversalEvent, appliedQuantity: revApplied, originalEventId: removeEvent.id,
        nextQuantity: afterReversal, expectedCurrentQuantity: removedProduct.quantity,
        product: removedProduct,
      });

      const finalProduct = await db.products.get(product.id);
      expect(finalProduct.quantity).toBe(5);  // not 8
    });

    it('enqueues exactly two sync entries (reversal event insert + product upsert)', async () => {
      const { updatedProduct, event, reversalEvent, appliedQuantity, nextQuantity } =
        await setupReversal(db, repo);
      await db.syncQueue.clear();
      await repo.commitReversal({
        reversalEvent, appliedQuantity, originalEventId: event.id,
        nextQuantity, expectedCurrentQuantity: updatedProduct.quantity,
        product: updatedProduct,
      });
      const entries = await db.syncQueue.toArray();
      expect(entries).toHaveLength(2);
    });

    it('reversal stockEvent sync entry has appliedQuantity in payload', async () => {
      const { updatedProduct, event, reversalEvent, appliedQuantity, nextQuantity } =
        await setupReversal(db, repo);
      await db.syncQueue.clear();
      await repo.commitReversal({
        reversalEvent, appliedQuantity, originalEventId: event.id,
        nextQuantity, expectedCurrentQuantity: updatedProduct.quantity,
        product: updatedProduct,
      });
      const entry = (await db.syncQueue.toArray())
        .find(e => e.entityType === 'stockEvent');
      expect(entry.operation).toBe('insert');
      expect(entry.entityId).toBe(reversalEvent.id);
      expect(entry.clientId).toBe(reversalEvent.id);
      expect(entry.payload.appliedQuantity).toBe(appliedQuantity);
    });

    it('reversal product sync entry has upsert operation and fresh clientId', async () => {
      const { updatedProduct, event, reversalEvent, appliedQuantity, nextQuantity } =
        await setupReversal(db, repo);
      await db.syncQueue.clear();
      await repo.commitReversal({
        reversalEvent, appliedQuantity, originalEventId: event.id,
        nextQuantity, expectedCurrentQuantity: updatedProduct.quantity,
        product: updatedProduct,
      });
      const entry = (await db.syncQueue.toArray())
        .find(e => e.entityType === 'product');
      expect(entry.operation).toBe('upsert');
      expect(entry.entityId).toBe(updatedProduct.id);
      expect(entry.clientId).not.toBe(updatedProduct.id);
    });
  });

  // =========================================================================
  // commitReversal — atomicity / rollback tests
  //
  // For each write position, verify the COMPLETE pre-call state is preserved.
  // Pre-call state for commitReversal:
  //   - reversal event: absent
  //   - original.reversedBy: null
  //   - product.quantity: updatedProduct.quantity (after the ADD)
  //   - syncQueue: empty (we clear it before each rollback test)
  // =========================================================================

  describe('commitReversal — atomicity', () => {
    async function setupReversalAttempt(db, repo) {
      const product = await seedProduct(db);
      const { event, updatedProduct } = await commitAddEvent(repo, product, 10);
      await db.syncQueue.clear();

      const stored = await repo.getById(event.id);
      const { reversalEvent } = createReversalEvent(stored, stored.appliedQuantity);
      const { nextQuantity, appliedQuantity } =
        applyStockEvent(updatedProduct.quantity, reversalEvent);

      async function doReversal() {
        return repo.commitReversal({
          reversalEvent, appliedQuantity, originalEventId: event.id,
          nextQuantity, expectedCurrentQuantity: updatedProduct.quantity,
          product: updatedProduct,
        });
      }

      async function assertReversalRolledBack() {
        // Reversal event must be absent
        expect(await db.stockEvents.get(reversalEvent.id)).toBeUndefined();
        // Original reversedBy must still be null
        const orig = await db.stockEvents.get(event.id);
        expect(orig.reversedBy).toBeNull();
        // Product quantity unchanged (still at updatedProduct.quantity = 10)
        const prod = await db.products.get(product.id);
        expect(prod.quantity).toBe(updatedProduct.quantity);
        // No sync entries from this attempt
        expect(await db.syncQueue.toArray()).toHaveLength(0);
      }

      return { event, updatedProduct, reversalEvent, doReversal, assertReversalRolledBack };
    }

    it('rolls back all writes when reversal stockEvents.add fails (write position 5)', async () => {
      const { doReversal, assertReversalRolledBack, event } =
        await setupReversalAttempt(db, repo);

      // The reversal event add is the first stockEvents.add after the
      // transaction opens (original is put, reversal is add — intercept add)
      const orig = db.stockEvents.add.bind(db.stockEvents);
      db.stockEvents.add = async () => {
        throw new Error('forced reversal stockEvents.add failure');
      };
      await expect(doReversal()).rejects.toThrow('forced reversal stockEvents.add failure');
      db.stockEvents.add = orig;

      await assertReversalRolledBack();
    });

    it('rolls back all writes when reversedBy patch (stockEvents.put) fails (write position 6)', async () => {
      const { doReversal, assertReversalRolledBack } =
        await setupReversalAttempt(db, repo);

      const orig = db.stockEvents.put.bind(db.stockEvents);
      db.stockEvents.put = async () => {
        throw new Error('forced reversedBy patch failure');
      };
      await expect(doReversal()).rejects.toThrow('forced reversedBy patch failure');
      db.stockEvents.put = orig;

      await assertReversalRolledBack();
    });

    it('rolls back all writes when products.put fails (write position 7)', async () => {
      const { doReversal, assertReversalRolledBack } =
        await setupReversalAttempt(db, repo);

      const orig = db.products.put.bind(db.products);
      db.products.put = async () => {
        throw new Error('forced products.put failure in reversal');
      };
      await expect(doReversal()).rejects.toThrow('forced products.put failure in reversal');
      db.products.put = orig;

      await assertReversalRolledBack();
    });

    it('rolls back all writes when reversal stockEvent syncQueue entry write fails (write position 8)', async () => {
      const { doReversal, assertReversalRolledBack } =
        await setupReversalAttempt(db, repo);

      let callCount = 0;
      const orig = db.syncQueue.add.bind(db.syncQueue);
      db.syncQueue.add = async (entry) => {
        callCount++;
        if (callCount === 1) throw new Error('forced syncQueue reversal-event failure');
        return orig(entry);
      };
      await expect(doReversal()).rejects.toThrow('forced syncQueue reversal-event failure');
      db.syncQueue.add = orig;

      await assertReversalRolledBack();
    });

    it('rolls back all writes when product syncQueue entry write fails (write position 9)', async () => {
      const { doReversal, assertReversalRolledBack } =
        await setupReversalAttempt(db, repo);

      let callCount = 0;
      const orig = db.syncQueue.add.bind(db.syncQueue);
      db.syncQueue.add = async (entry) => {
        callCount++;
        if (callCount === 2) throw new Error('forced syncQueue product failure in reversal');
        return orig(entry);
      };
      await expect(doReversal()).rejects.toThrow('forced syncQueue product failure in reversal');
      db.syncQueue.add = orig;

      await assertReversalRolledBack();
    });
  });
});
