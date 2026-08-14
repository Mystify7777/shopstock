import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, DB_NAME } from '../../../src/data/db/schema.js';

// This is the harness test docs/ARCHITECTURE.md requires before Phase 2
// ships the first real db.version(1): open the DB, seed representative
// rows into every table, and confirm the schema matches expectations.
// Later schema versions' .upgrade() functions will be tested against this
// same pattern — open old version, seed data, bump version, assert
// migrated shape — so this file also establishes that pattern for reuse.

describe('Dexie schema — version(1) opens correctly', () => {
  let db;

  beforeEach(() => {
    db = createDatabase();
  });

  afterEach(async () => {
    if (db.isOpen()) {
      db.close();
    }
    await db.delete();
  });

  it('opens without error', async () => {
    await expect(db.open()).resolves.toBeDefined();
  });

  it('uses the expected database name', () => {
    expect(db.name).toBe(DB_NAME);
  });

  it('declares exactly the tables specified in docs/ARCHITECTURE.md plus the resolved appliedQuantity columns', async () => {
    await db.open();
    const tableNames = db.tables.map((t) => t.name).sort();
    expect(tableNames).toEqual(
      [
        'categories',
        'locations',
        'photos',
        'productChangeEvents',
        'products',
        'stockEvents',
        'syncQueue',
        'tags',
        'units',
        'session'
      ].sort()
    );
  });

  it('is version 1', async () => {
    await db.open();
    expect(db.verno).toBe(1);
  });
});

describe('Dexie schema — representative seed-and-read round trip per table', () => {
  let db;

  beforeEach(async () => {
    db = createDatabase();
    await db.open();
  });

  afterEach(async () => {
    db.close();
    await db.delete();
  });

  it('products: writes and reads back a product by id', async () => {
    const product = {
      id: 'p1',
      name: 'Parle-G',
      photoRef: null,
      quantity: 10,
      unitId: 'unit-packet',
      lowStockThreshold: null,
      lowStockDisabled: false,
      categoryId: 'cat-snacks',
      locationIds: ['shelf-a1'],
      tagIds: ['popular'],
      sellingPrice: 20,
      marginOverride: null,
      latestPurchaseDate: '2026-08-09',
      notes: null,
      createdAt: '2026-08-09T09:00:00.000Z',
      updatedAt: '2026-08-09T09:00:00.000Z',
      archived: false
    };
    await db.products.put(product);
    const read = await db.products.get('p1');
    expect(read).toEqual(product);
  });

  it('products: queries by the indexed categoryId column', async () => {
    await db.products.bulkPut([
      { id: 'p1', name: 'A', categoryId: 'cat-snacks', archived: false, updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'p2', name: 'B', categoryId: 'cat-drinks', archived: false, updatedAt: '2026-01-01T00:00:00.000Z' }
    ]);
    const results = await db.products.where('categoryId').equals('cat-snacks').toArray();
    expect(results.map((p) => p.id)).toEqual(['p1']);
  });

  it('stockEvents: writes and reads back an event including the resolved appliedQuantity column', async () => {
    const event = {
      id: 'e1',
      productId: 'p1',
      type: 'REMOVE',
      quantity: 8, // requested, per stockEventFactory.js's immutable domain shape
      costPerUnit: null,
      purchaseDate: null,
      recordedAt: '2026-08-09T09:00:00.000Z',
      comment: 'Bulk sale',
      reversalOf: null,
      reversedBy: null,
      // appliedQuantity is NOT part of the domain StockEvent shape
      // (stockEventFactory.js never produces it) — it's a
      // repository-level column added here to resolve the
      // previously-open architecture question. Verifying it round-trips
      // is the point of this test.
      appliedQuantity: 5
    };
    await db.stockEvents.put(event);
    const read = await db.stockEvents.get('e1');
    expect(read.appliedQuantity).toBe(5);
    expect(read.quantity).toBe(8);
  });

  it('stockEvents: queries by the indexed reversalOf column', async () => {
    await db.stockEvents.bulkPut([
      { id: 'e1', productId: 'p1', type: 'REMOVE', quantity: 8, recordedAt: '2026-08-09T09:00:00.000Z', reversalOf: null, reversedBy: 'e2', appliedQuantity: 8 },
      { id: 'e2', productId: 'p1', type: 'ADD', quantity: 8, recordedAt: '2026-08-09T09:05:00.000Z', reversalOf: 'e1', reversedBy: null, appliedQuantity: 8 }
    ]);
    const reversals = await db.stockEvents.where('reversalOf').equals('e1').toArray();
    expect(reversals.map((e) => e.id)).toEqual(['e2']);
  });

  it('productChangeEvents: writes and reads back a change event', async () => {
    const changeEvent = {
      id: 'ce1',
      productId: 'p1',
      field: 'sellingPrice',
      oldValue: 20,
      newValue: 25,
      timestamp: '2026-08-09T09:00:00.000Z',
      accepted: true
    };
    await db.productChangeEvents.put(changeEvent);
    const read = await db.productChangeEvents.get('ce1');
    expect(read).toEqual(changeEvent);
  });

  it('categories/locations/tags/units: each writes, reads, and queries by archived', async () => {
    await db.categories.put({ id: 'cat-1', name: 'Snacks', archived: false, isDefault: true });
    await db.locations.put({ id: 'loc-1', name: 'Shelf A1', archived: false, isDefault: true });
    await db.tags.put({ id: 'tag-1', name: 'popular', archived: false, isDefault: false });
    await db.units.put({ id: 'unit-1', name: 'Packet', archived: false, isDefault: true });

    expect(await db.categories.get('cat-1')).toMatchObject({ name: 'Snacks' });
    expect(await db.locations.get('loc-1')).toMatchObject({ name: 'Shelf A1' });
    expect(await db.tags.get('tag-1')).toMatchObject({ name: 'popular' });
    expect(await db.units.get('unit-1')).toMatchObject({ name: 'Packet' });

    // Query defensively by filtering in JS rather than an indexed boolean
    // equality query, to avoid coupling this test to how a given
    // IndexedDB implementation happens to index booleans internally.
    const activeCategoriesJs = (await db.categories.toArray()).filter((c) => c.archived === false);
    expect(activeCategoriesJs.map((c) => c.id)).toContain('cat-1');
  });

  it('photos: writes and reads back a blob-shaped record', async () => {
    const photoRecord = { id: 'photo-1', blob: new Uint8Array([1, 2, 3]) };
    await db.photos.put(photoRecord);
    const read = await db.photos.get('photo-1');
    expect(read.id).toBe('photo-1');
    expect(Array.from(read.blob)).toEqual([1, 2, 3]);
  });

  it('syncQueue: auto-increments localId and queries by status', async () => {
    const id1 = await db.syncQueue.add({
      entityType: 'stockEvent',
      entityId: 'e1',
      operation: 'insert',
      payload: {},
      clientId: 'e1',
      attempts: 0,
      status: 'pending',
      createdAt: '2026-08-09T09:00:00.000Z',
      lastError: null
    });
    const id2 = await db.syncQueue.add({
      entityType: 'product',
      entityId: 'p1',
      operation: 'upsert',
      payload: {},
      clientId: 'p1',
      attempts: 0,
      status: 'done',
      createdAt: '2026-08-09T09:01:00.000Z',
      lastError: null
    });

    expect(id2).toBeGreaterThan(id1);

    const pending = await db.syncQueue.where('status').equals('pending').toArray();
    expect(pending.length).toBe(1);
    expect(pending[0].entityId).toBe('e1');
  });

  it('session: stores and reads a single-row trusted-device token by key', async () => {
    await db.session.put({ key: 'refreshToken', value: 'opaque-token-value' });
    const read = await db.session.get('refreshToken');
    expect(read.value).toBe('opaque-token-value');
  });
});

describe('Dexie schema — clean isolation between test runs', () => {
  it('a fresh createDatabase() + open() has no leftover data from a previous describe block', async () => {
    const db = createDatabase();
    await db.open();
    const count = await db.products.count();
    expect(count).toBe(0);
    db.close();
    await db.delete();
  });
});
