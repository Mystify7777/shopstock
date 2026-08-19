import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../db/schema.js';
import {
  createProductRepository,
  ProductNotFoundError,
  QuantityMutationError,
  InvalidChangeEventsError,
  UnrecognizedListOptionError
} from './productRepository.js';
import { createProduct } from '../../domain/product/productFactory.js';
import { generateId } from '../../domain/shared/ids.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a valid, already-created product via the domain factory. */
function makeProduct(overrides = {}) {
  const { product } = createProduct({ name: 'Test Product', ...overrides });
  return product;
}

/**
 * Build a minimal ProductChangeEvent already shaped as the service would
 * construct it (the repository takes these pre-built, never constructs them).
 */
function makeChangeEvent(productId, overrides = {}) {
  return {
    id: generateId(),
    productId,
    field: 'name',
    oldValue: 'Old Name',
    newValue: 'New Name',
    timestamp: new Date().toISOString(),
    accepted: true,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

describe('productRepository', () => {
  let db;
  let repo;

  beforeEach(() => {
    db = createDatabase();
    repo = createProductRepository(db);
  });

  afterEach(async () => {
    if (db.isOpen()) db.close();
    await db.delete();
  });

  // =========================================================================
  // getById
  // =========================================================================

  describe('getById', () => {
    it('returns undefined for an id that does not exist', async () => {
      const result = await repo.getById('nonexistent-id');
      expect(result).toBeUndefined();
    });

    it('returns the product after it has been created', async () => {
      const product = makeProduct();
      await repo.create(product);
      const result = await repo.getById(product.id);
      expect(result).toMatchObject({ id: product.id, name: 'Test Product' });
    });

    it('returns the updated product after update()', async () => {
      const product = makeProduct();
      await repo.create(product);
      const { product: updated } = require('../../domain/product/productFactory.js').updateProduct(
        product,
        { name: 'Updated Name' }
      );
      await repo.update(updated, []);
      const result = await repo.getById(product.id);
      expect(result.name).toBe('Updated Name');
    });
  });

  // =========================================================================
  // list
  // =========================================================================

  describe('list', () => {
    it('returns an empty array when no products exist', async () => {
      expect(await repo.list()).toEqual([]);
    });

    it('returns active products by default', async () => {
      const active = makeProduct({ name: 'Active' });
      await repo.create(active);
      const results = await repo.list();
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(active.id);
    });

    it('excludes archived products by default', async () => {
      const { updateProduct } = await import('../../domain/product/productFactory.js');
      const product = makeProduct({ name: 'To Archive' });
      await repo.create(product);
      const { product: archived } = updateProduct(product, { archived: true });
      await repo.update(archived, []);
      const results = await repo.list();
      expect(results).toHaveLength(0);
    });

    it('returns archived products when includeArchived is true', async () => {
      const { updateProduct } = await import('../../domain/product/productFactory.js');
      const product = makeProduct({ name: 'Archived' });
      await repo.create(product);
      const { product: archived } = updateProduct(product, { archived: true });
      await repo.update(archived, []);
      const results = await repo.list({ includeArchived: true });
      expect(results).toHaveLength(1);
      expect(results[0].archived).toBe(true);
    });

    it('returns both active and archived products when includeArchived is true', async () => {
      const { updateProduct } = await import('../../domain/product/productFactory.js');
      const active = makeProduct({ name: 'Active' });
      const toArchive = makeProduct({ name: 'Archived' });
      await repo.create(active);
      await repo.create(toArchive);
      const { product: archived } = updateProduct(toArchive, { archived: true });
      await repo.update(archived, []);
      const results = await repo.list({ includeArchived: true });
      expect(results).toHaveLength(2);
    });

    it('throws for an unrecognized option key', async () => {
      await expect(repo.list({ sort: 'name' })).rejects.toThrow(
        UnrecognizedListOptionError
      );
    });

    it('throws for multiple unrecognized option keys', async () => {
      await expect(
        repo.list({ includeArchived: true, limit: 10 })
      ).rejects.toThrow(UnrecognizedListOptionError);
    });
  });

  // =========================================================================
  // create
  // =========================================================================

  describe('create', () => {
    it('persists the product so getById can read it back', async () => {
      const product = makeProduct({ name: 'New Product' });
      const result = await repo.create(product);
      expect(result).toBe(product); // returns the same object
      const read = await repo.getById(product.id);
      expect(read).toMatchObject({ id: product.id, name: 'New Product' });
    });

    it('enqueues exactly one syncQueue entry with entityType product', async () => {
      const product = makeProduct();
      await repo.create(product);
      const entries = await db.syncQueue.toArray();
      expect(entries).toHaveLength(1);
      expect(entries[0].entityType).toBe('product');
      expect(entries[0].operation).toBe('upsert');
    });

    it('sets entityId to product.id', async () => {
      const product = makeProduct();
      await repo.create(product);
      const [entry] = await db.syncQueue.toArray();
      expect(entry.entityId).toBe(product.id);
    });

    it('sets clientId to a fresh id — NOT product.id', async () => {
      const product = makeProduct();
      await repo.create(product);
      const [entry] = await db.syncQueue.toArray();
      expect(entry.clientId).not.toBe(product.id);
    });

    it('clientId is a non-empty string', async () => {
      const product = makeProduct();
      await repo.create(product);
      const [entry] = await db.syncQueue.toArray();
      expect(typeof entry.clientId).toBe('string');
      expect(entry.clientId.length).toBeGreaterThan(0);
    });

    it('sets status to pending, attempts to 0, lastError to null', async () => {
      const product = makeProduct();
      await repo.create(product);
      const [entry] = await db.syncQueue.toArray();
      expect(entry.status).toBe('pending');
      expect(entry.attempts).toBe(0);
      expect(entry.lastError).toBeNull();
    });

    it('includes the full product as the payload', async () => {
      const product = makeProduct({ name: 'Payload Test' });
      await repo.create(product);
      const [entry] = await db.syncQueue.toArray();
      expect(entry.payload).toMatchObject({ id: product.id, name: 'Payload Test' });
    });

    it('does NOT create any ProductChangeEvents', async () => {
      const product = makeProduct();
      await repo.create(product);
      const events = await db.productChangeEvents.toArray();
      expect(events).toHaveLength(0);
    });

    // -----------------------------------------------------------------------
    // clientId uniqueness across multiple creates
    // -----------------------------------------------------------------------

    it('generates a different clientId for each product created', async () => {
      const p1 = makeProduct({ name: 'Product 1' });
      const p2 = makeProduct({ name: 'Product 2' });
      await repo.create(p1);
      await repo.create(p2);
      const entries = await db.syncQueue.toArray();
      expect(entries[0].clientId).not.toBe(entries[1].clientId);
    });
  });

  // =========================================================================
  // update
  // =========================================================================

  describe('update', () => {
    it('persists the updated product', async () => {
      const { updateProduct } = await import('../../domain/product/productFactory.js');
      const product = makeProduct({ name: 'Original' });
      await repo.create(product);
      const { product: updated } = updateProduct(product, { name: 'Changed' });
      await repo.update(updated, []);
      const read = await repo.getById(product.id);
      expect(read.name).toBe('Changed');
    });

    it('returns the updated product', async () => {
      const { updateProduct } = await import('../../domain/product/productFactory.js');
      const product = makeProduct();
      await repo.create(product);
      const { product: updated } = updateProduct(product, { notes: 'a note' });
      const result = await repo.update(updated, []);
      expect(result).toBe(updated);
    });

    // -----------------------------------------------------------------------
    // Quantity invariant
    // -----------------------------------------------------------------------

    it('throws QuantityMutationError when quantity differs from stored', async () => {
      const product = makeProduct();
      await repo.create(product); // stored quantity = 0
      const tampered = { ...product, quantity: 11 };
      await expect(repo.update(tampered, [])).rejects.toThrow(QuantityMutationError);
    });

    it('leaves the stored product unchanged after a QuantityMutationError', async () => {
      const product = makeProduct({ name: 'Unchanged' });
      await repo.create(product);
      const tampered = { ...product, quantity: 99 };
      await expect(repo.update(tampered, [])).rejects.toThrow(QuantityMutationError);
      const stored = await repo.getById(product.id);
      expect(stored.quantity).toBe(0);
      expect(stored.name).toBe('Unchanged');
    });

    it('creates no syncQueue entries after a QuantityMutationError', async () => {
      const product = makeProduct();
      await repo.create(product);
      const beforeCount = (await db.syncQueue.toArray()).length;
      await expect(
        repo.update({ ...product, quantity: 5 }, [])
      ).rejects.toThrow(QuantityMutationError);
      const afterCount = (await db.syncQueue.toArray()).length;
      expect(afterCount).toBe(beforeCount); // no new entries
    });

    // -----------------------------------------------------------------------
    // ProductNotFoundError
    // -----------------------------------------------------------------------

    it('throws ProductNotFoundError when the product does not exist', async () => {
      const product = makeProduct();
      // intentionally NOT created — the product doesn't exist in the DB
      await expect(repo.update(product, [])).rejects.toThrow(ProductNotFoundError);
    });

    // -----------------------------------------------------------------------
    // changeEvents validation
    // -----------------------------------------------------------------------

    it('throws InvalidChangeEventsError when changeEvents is not an array', async () => {
      const product = makeProduct();
      await repo.create(product);
      await expect(repo.update(product, 'not-an-array')).rejects.toThrow(
        InvalidChangeEventsError
      );
    });

    it('throws InvalidChangeEventsError when an event has a mismatched productId', async () => {
      const product = makeProduct();
      await repo.create(product);
      const badEvent = makeChangeEvent('different-product-id');
      await expect(repo.update(product, [badEvent])).rejects.toThrow(
        InvalidChangeEventsError
      );
    });

    it('throws InvalidChangeEventsError (not TypeError) for null or undefined entries', async () => {
      const product = makeProduct();
      await repo.create(product);
      await expect(repo.update(product, [null])).rejects.toThrow(InvalidChangeEventsError);
      await expect(repo.update(product, [undefined])).rejects.toThrow(InvalidChangeEventsError);
    });

    // -----------------------------------------------------------------------
    // Update with no changeEvents (non-tracked field edit, e.g. notes)
    // -----------------------------------------------------------------------

    it('succeeds with an empty changeEvents array', async () => {
      const { updateProduct } = await import('../../domain/product/productFactory.js');
      const product = makeProduct();
      await repo.create(product);
      const { product: updated } = updateProduct(product, { notes: 'just a note' });
      await expect(repo.update(updated, [])).resolves.toBeDefined();
    });

    it('writes exactly one syncQueue entry (product upsert) when changeEvents is empty', async () => {
      const { updateProduct } = await import('../../domain/product/productFactory.js');
      const product = makeProduct();
      await repo.create(product);
      await db.syncQueue.clear();
      const { product: updated } = updateProduct(product, { notes: 'note' });
      await repo.update(updated, []);
      const entries = await db.syncQueue.toArray();
      expect(entries).toHaveLength(1);
      expect(entries[0].entityType).toBe('product');
    });

    // -----------------------------------------------------------------------
    // Update with changeEvents (tracked field edits)
    // -----------------------------------------------------------------------

    it('persists each ProductChangeEvent when provided', async () => {
      const { updateProduct } = await import('../../domain/product/productFactory.js');
      const product = makeProduct({ name: 'Original Name' });
      await repo.create(product);
      const { product: updated } = updateProduct(product, { name: 'New Name' });
      const event = makeChangeEvent(product.id, {
        field: 'name',
        oldValue: 'Original Name',
        newValue: 'New Name'
      });
      await repo.update(updated, [event]);
      const stored = await db.productChangeEvents.toArray();
      expect(stored).toHaveLength(1);
      expect(stored[0].id).toBe(event.id);
      expect(stored[0].field).toBe('name');
    });

    it('enqueues a productChangeEvent syncQueue entry for each changeEvent', async () => {
      const { updateProduct } = await import('../../domain/product/productFactory.js');
      const product = makeProduct({ name: 'Before' });
      await repo.create(product);
      await db.syncQueue.clear();
      const { product: updated } = updateProduct(product, { name: 'After' });
      const event = makeChangeEvent(product.id, { field: 'name' });
      await repo.update(updated, [event]);
      const entries = await db.syncQueue.toArray();
      const changeEventEntry = entries.find(
        (e) => e.entityType === 'productChangeEvent'
      );
      expect(changeEventEntry).toBeDefined();
      expect(changeEventEntry.entityId).toBe(event.id);
      expect(changeEventEntry.clientId).toBe(event.id); // insert: clientId === entityId
      expect(changeEventEntry.operation).toBe('insert');
    });

    it('enqueues a product upsert syncQueue entry in addition to changeEvent entries', async () => {
      const { updateProduct } = await import('../../domain/product/productFactory.js');
      const product = makeProduct({ name: 'Before' });
      await repo.create(product);
      await db.syncQueue.clear();
      const { product: updated } = updateProduct(product, { name: 'After' });
      const event = makeChangeEvent(product.id);
      await repo.update(updated, [event]);
      const entries = await db.syncQueue.toArray();
      const productEntry = entries.find((e) => e.entityType === 'product');
      expect(productEntry).toBeDefined();
      expect(productEntry.operation).toBe('upsert');
      expect(productEntry.entityId).toBe(product.id);
    });

    it('enqueues N+1 total sync entries for N changeEvents', async () => {
      const { updateProduct } = await import('../../domain/product/productFactory.js');
      const product = makeProduct({ name: 'Start', sellingPrice: 10 });
      await repo.create(product);
      await db.syncQueue.clear();
      const { product: updated } = updateProduct(product, {
        name: 'End',
        sellingPrice: 20
      });
      const events = [
        makeChangeEvent(product.id, { field: 'name' }),
        makeChangeEvent(product.id, { field: 'sellingPrice' })
      ];
      await repo.update(updated, events);
      const entries = await db.syncQueue.toArray();
      expect(entries).toHaveLength(3); // 2 event entries + 1 product entry
    });

    // -----------------------------------------------------------------------
    // clientId semantics — the critical test
    // -----------------------------------------------------------------------

    it('product upsert: two mutations to the same product have the same entityId but different clientIds', async () => {
      const { updateProduct } = await import('../../domain/product/productFactory.js');
      const product = makeProduct({ name: 'V1' });
      await repo.create(product);
      await db.syncQueue.clear();

      // First mutation
      const { product: v2 } = updateProduct(product, { name: 'V2' });
      await repo.update(v2, []);

      // Second mutation (must use v2 as base, otherwise updatedAt is stale)
      const { product: v3 } = updateProduct(v2, { notes: 'second mutation' });
      await repo.update(v3, []);

      const entries = await db.syncQueue
        .where('entityType')
        .equals('product')
        .toArray();
      expect(entries).toHaveLength(2);
      expect(entries[0].entityId).toBe(product.id);
      expect(entries[1].entityId).toBe(product.id);  // same entity
      expect(entries[0].clientId).not.toBe(entries[1].clientId); // different mutation IDs
    });

    it('productChangeEvent: entityId === clientId === event.id', async () => {
      const { updateProduct } = await import('../../domain/product/productFactory.js');
      const product = makeProduct({ name: 'A' });
      await repo.create(product);
      await db.syncQueue.clear();
      const { product: updated } = updateProduct(product, { name: 'B' });
      const event = makeChangeEvent(product.id, { field: 'name' });
      await repo.update(updated, [event]);
      const entry = await db.syncQueue
        .where('entityType')
        .equals('productChangeEvent')
        .first();
      expect(entry.entityId).toBe(event.id);
      expect(entry.clientId).toBe(event.id);
      expect(entry.entityId).toBe(entry.clientId);
    });
  });

  // =========================================================================
  // Atomicity — the rollback tests
  //
  // Strategy: monkey-patch db.syncQueue.add to throw after a targeted write,
  // then assert that NONE of the preceding writes in the transaction remain.
  //
  // This proves Dexie's 'rw' transaction provides genuine all-or-nothing
  // semantics for the three tables in scope, not merely sequential error
  // propagation that happens to look like atomicity.
  // =========================================================================

  describe('atomicity — create()', () => {
    it('rolls back the product write if the syncQueue write fails', async () => {
      const product = makeProduct({ name: 'Atomic Create' });

      // Force syncQueue.add to throw
      const originalAdd = db.syncQueue.add.bind(db.syncQueue);
      db.syncQueue.add = async () => {
        throw new Error('forced syncQueue failure');
      };

      await expect(repo.create(product)).rejects.toThrow('forced syncQueue failure');

      // Restore so afterEach cleanup can work
      db.syncQueue.add = originalAdd;

      // The product write must have been rolled back
      const stored = await db.products.get(product.id);
      expect(stored).toBeUndefined();

      // No sync entries
      const entries = await db.syncQueue.toArray();
      expect(entries).toHaveLength(0);
    });
  });

  describe('atomicity — update()', () => {
    it('rolls back product and changeEvent writes if the syncQueue product-upsert write fails', async () => {
      const { updateProduct } = await import('../../domain/product/productFactory.js');
      const product = makeProduct({ name: 'Before' });
      await repo.create(product);
      await db.syncQueue.clear();

      const { product: updated } = updateProduct(product, { name: 'After' });
      const event = makeChangeEvent(product.id, { field: 'name' });

      // Force the LAST syncQueue write (product upsert) to fail.
      // changeEvent syncQueue entries are written first, so we count calls
      // and throw on the second one (the product upsert).
      let syncAddCallCount = 0;
      const originalAdd = db.syncQueue.add.bind(db.syncQueue);
      db.syncQueue.add = async (entry) => {
        syncAddCallCount++;
        if (syncAddCallCount === 2) {
          throw new Error('forced syncQueue product-upsert failure');
        }
        return originalAdd(entry);
      };

      await expect(repo.update(updated, [event])).rejects.toThrow(
        'forced syncQueue product-upsert failure'
      );

      db.syncQueue.add = originalAdd;

      // Product must still show the old name
      const stored = await db.products.get(product.id);
      expect(stored.name).toBe('Before');

      // No ProductChangeEvents
      const events = await db.productChangeEvents.toArray();
      expect(events).toHaveLength(0);

      // No sync entries from this update attempt
      const entries = await db.syncQueue.toArray();
      expect(entries).toHaveLength(0);
    });

    it('rolls back everything if the productChangeEvents write fails', async () => {
      const { updateProduct } = await import('../../domain/product/productFactory.js');
      const product = makeProduct({ name: 'Original' });
      await repo.create(product);
      await db.syncQueue.clear();

      const { product: updated } = updateProduct(product, { name: 'Changed' });
      const event = makeChangeEvent(product.id, { field: 'name' });

      // Force productChangeEvents.add to throw
      const originalAdd = db.productChangeEvents.add.bind(db.productChangeEvents);
      db.productChangeEvents.add = async () => {
        throw new Error('forced productChangeEvents failure');
      };

      await expect(repo.update(updated, [event])).rejects.toThrow(
        'forced productChangeEvents failure'
      );

      db.productChangeEvents.add = originalAdd;

      // Product must remain at original state
      const stored = await db.products.get(product.id);
      expect(stored.name).toBe('Original');

      // No ProductChangeEvents committed
      const events = await db.productChangeEvents.toArray();
      expect(events).toHaveLength(0);

      // No sync entries from this update
      const entries = await db.syncQueue.toArray();
      expect(entries).toHaveLength(0);
    });

    it('rolls back everything if the products.put write fails', async () => {
      const { updateProduct } = await import('../../domain/product/productFactory.js');
      const product = makeProduct({ name: 'Pre-failure' });
      await repo.create(product);
      await db.syncQueue.clear();

      const { product: updated } = updateProduct(product, { name: 'Post-failure' });
      const event = makeChangeEvent(product.id, { field: 'name' });

      // Force products.put to throw
      const originalPut = db.products.put.bind(db.products);
      db.products.put = async () => {
        throw new Error('forced products.put failure');
      };

      await expect(repo.update(updated, [event])).rejects.toThrow(
        'forced products.put failure'
      );

      db.products.put = originalPut;

      // Product unchanged
      const stored = await db.products.get(product.id);
      expect(stored.name).toBe('Pre-failure');

      // Nothing else written
      const events = await db.productChangeEvents.toArray();
      expect(events).toHaveLength(0);
      const entries = await db.syncQueue.toArray();
      expect(entries).toHaveLength(0);
    });
  });
});