// Phase 6G — system-level verification gaps (frontend, Mongo-free).
//
// Existing coverage (deliberately NOT duplicated here): FIFO/single-flight/
// failure policy (syncDrainer*.test.js), 401 single-flight refresh and
// refresh failure through the full chain (syncDrainer.integration.test.js,
// apiClient.test.js), startup/online triggers (syncTriggers.test.js),
// reversal path (reversalSync.integration.test.js).
//
// Gaps closed here:
//   1. A REAL restart: the Dexie instance is closed and a brand-new
//      instance opens the same database. (The older "crash recovery"
//      test seeds a row with status 'processing' by hand.)
//   2. All seven queue entity types, originating from REAL repository /
//      service mutations (not hand-built rows), drained through the real
//      chain to the correct Phase 5 PUT endpoint.
//
// Only global fetch is mocked -- the same single seam as 6C-5.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDatabase } from '../db/schema.js';
import { createProductRepository } from '../repositories/productRepository.js';
import { createClassificationRepository } from '../repositories/classificationRepository.js';
import { createProductService } from '../../services/productService.js';
import { createStockEventService } from '../../services/stockEventService.js';
import { createStockEventRepository } from '../repositories/stockEventRepository.js';
import { createSyncQueueLifecycle } from './syncQueueLifecycle.js';
import { createSyncEntryExecutor } from './syncEntryExecutor.js';
import { createSyncDrainer } from './syncDrainer.js';
import { createSessionStore } from '../../auth/sessionStore.js';
import { createAuthClient } from '../../auth/authClient.js';
import { createAuthManager } from '../../auth/authManager.js';
import { createApiClient } from '../../auth/apiClient.js';

const BASE_URL = 'https://api.example.com';

// Composes exactly what main.jsx composes, over a given Dexie instance.
function composeChain(db) {
  const sessionStore = createSessionStore(db);
  const authManager = createAuthManager({ sessionStore, authClient: createAuthClient(BASE_URL) });
  const apiClient = createApiClient({ authManager, baseUrl: BASE_URL });
  const syncQueueLifecycle = createSyncQueueLifecycle(db);
  const syncDrainer = createSyncDrainer({
    syncQueueLifecycle,
    syncEntryExecutor: createSyncEntryExecutor({ apiClient }),
  });
  return { sessionStore, syncQueueLifecycle, syncDrainer };
}

function mockFetchOk() {
  const seen = [];
  global.fetch = vi.fn(async (url, init) => {
    seen.push({ method: init.method, path: new URL(url).pathname, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: () => Promise.resolve({ ok: true }) };
  });
  return seen;
}

describe('Phase 6G — restart recovery across a real database reopen', () => {
  let db1;
  let db2;

  afterEach(async () => {
    vi.restoreAllMocks();
    delete global.fetch;
    for (const d of [db1, db2]) if (d?.isOpen()) d.close();
    await (db2 ?? db1)?.delete();
  });

  it('pending -> claimed (processing) -> instance disappears -> new instance recovers -> next drain delivers and deletes it', async () => {
    db1 = createDatabase();
    const first = composeChain(db1);
    await first.sessionStore.setRefreshToken('valid-refresh-token');
    await createClassificationRepository(db1).create('category', {
      id: 'cat-restart', name: 'Snacks', archived: false, isDefault: false,
    });

    // Claim as the drainer would, then the "app dies" mid-request.
    const claimed = await first.syncQueueLifecycle.claimNextPending();
    expect(claimed.status).toBe('processing');
    db1.close(); // no markSucceeded / markFailed ever runs

    // Brand-new Dexie instance over the SAME persisted database.
    db2 = createDatabase();
    const [row] = await db2.syncQueue.toArray();
    expect(row.status).toBe('processing'); // genuinely persisted stale state
    expect(row.entityId).toBe('cat-restart');

    const second = composeChain(db2);
    const seen = mockFetchOk();
    const result = await second.syncDrainer.drain(); // recovery + drain

    expect(result).toEqual({ processed: 1, failed: 0, stopped: false, reason: null });
    expect(seen).toEqual([
      expect.objectContaining({ method: 'PUT', path: '/api/categories/cat-restart' }),
    ]);
    expect(await db2.syncQueue.count()).toBe(0);
  });

  it('queue order, failed rows and pending rows all survive a reopen; failed rows are not retried', async () => {
    db1 = createDatabase();
    const repo = createClassificationRepository(db1);
    for (const id of ['a', 'b', 'c']) {
      await repo.create('tag', { id: `tag-${id}`, name: id, archived: false, isDefault: false });
    }
    const rows = await db1.syncQueue.orderBy('localId').toArray();
    await createSyncQueueLifecycle(db1).markFailed(rows[1].localId, 'VALIDATION_ERROR: nope (status 400)');
    db1.close();

    db2 = createDatabase();
    const after = await db2.syncQueue.orderBy('localId').toArray();
    expect(after.map((r) => [r.entityId, r.status])).toEqual([
      ['tag-a', 'pending'], ['tag-b', 'failed'], ['tag-c', 'pending'],
    ]);

    const chain = composeChain(db2);
    await chain.sessionStore.setRefreshToken('valid-refresh-token');
    const seen = mockFetchOk();
    const result = await chain.syncDrainer.drain();

    expect(seen.map((r) => r.path)).toEqual(['/api/tags/tag-a', '/api/tags/tag-c']); // FIFO, failed skipped
    expect(result.processed).toBe(2);
    const left = await db2.syncQueue.toArray();
    expect(left.map((r) => [r.entityId, r.status])).toEqual([['tag-b', 'failed']]);
  });
});

describe('Phase 6G — all seven entity types: real mutation -> queue -> real chain -> correct endpoint', () => {
  let db;

  beforeEach(() => { db = createDatabase(); });
  afterEach(async () => {
    vi.restoreAllMocks();
    delete global.fetch;
    if (db.isOpen()) db.close();
    await db.delete();
  });

  it('category, location, tag, unit, product, stockEvent and productChangeEvent each reach their own Phase 5 PUT endpoint, in mutation order', async () => {
    const classifications = createClassificationRepository(db);
    const productRepository = createProductRepository(db);
    const productService = createProductService(productRepository, classifications);
    const stockService = createStockEventService(createStockEventRepository(db), productRepository);

    await classifications.create('category', { id: 'cat-1', name: 'Snacks', archived: false, isDefault: false });
    await classifications.create('location', { id: 'loc-1', name: 'Shelf A2', archived: false, isDefault: false });
    await classifications.create('tag', { id: 'tag-1', name: 'popular', archived: false, isDefault: false });
    await classifications.create('unit', { id: 'unit-1', name: 'Packet', archived: false, isDefault: false });

    const { product } = await productService.createProduct({ name: 'Parle-G' });
    const { event: stock } = await stockService.addStock({ productId: product.id, quantity: 5 });
    // A tracked-field edit produces a real ProductChangeEvent + Product upsert.
    const current = await productRepository.getById(product.id); // fresh: quantity is now 5
    const { product: renamed, errors } = await productService.updateProduct(current, { sellingPrice: 12 });
    expect(errors).toEqual([]);
    const changeRows = await db.syncQueue.where('entityType').equals('productChangeEvent').toArray();
    expect(changeRows.length).toBeGreaterThan(0);
    const changeId = changeRows[0].entityId;

    // Every entity type is present in the queue...
    const types = new Set((await db.syncQueue.toArray()).map((r) => r.entityType));
    expect(types).toEqual(new Set([
      'category', 'location', 'tag', 'unit', 'product', 'stockEvent', 'productChangeEvent',
    ]));

    const chain = composeChain(db);
    await chain.sessionStore.setRefreshToken('valid-refresh-token');
    const seen = mockFetchOk();
    const queued = await db.syncQueue.count();

    const result = await chain.syncDrainer.drain();

    expect(result).toEqual({ processed: queued, failed: 0, stopped: false, reason: null });
    expect(await db.syncQueue.count()).toBe(0); // success deletes; there is no 'done' state
    expect(seen.every((r) => r.method === 'PUT')).toBe(true);

    const paths = seen.map((r) => r.path);
    for (const expected of [
      '/api/categories/cat-1', '/api/locations/loc-1', '/api/tags/tag-1', '/api/units/unit-1',
      `/api/products/${product.id}`, `/api/stock-events/${stock.id}`, `/api/product-change-events/${changeId}`,
    ]) {
      expect(paths).toContain(expected);
    }
    // Global localId FIFO: classifications first, then the product, then its stock event.
    expect(paths.indexOf('/api/categories/cat-1')).toBeLessThan(paths.indexOf(`/api/products/${product.id}`));
    expect(paths.indexOf(`/api/products/${product.id}`)).toBeLessThan(paths.indexOf(`/api/stock-events/${stock.id}`));

    // Wire hygiene across the real seam.
    const productBodies = seen.filter((r) => r.path === `/api/products/${product.id}`).map((r) => r.body);
    expect(productBodies.every((b) => !Object.hasOwn(b, 'quantity'))).toBe(true);
    expect(seen.find((r) => r.path.startsWith('/api/product-change-events/')).body).not.toHaveProperty('accepted');
    const stockBody = seen.find((r) => r.path === `/api/stock-events/${stock.id}`).body;
    expect(stockBody).not.toHaveProperty('appliedQuantity');
    expect(stockBody.expectedCurrentQuantity).toBe(0);
    expect(renamed.sellingPrice).toBe(12);
    const priceMutation = productBodies.find((b) => b.fieldMutations?.sellingPrice);
    expect(priceMutation.fieldMutations.sellingPrice).toEqual({
      timestamp: expect.any(String), eventId: expect.any(String),
    });
    expect(priceMutation.fieldMutations.sellingPrice.eventId).toBe(changeId);
  });
});
