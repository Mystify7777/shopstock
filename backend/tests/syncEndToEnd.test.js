// Phase 6G — real end-to-end: REAL frontend code -> REAL HTTP -> REAL
// Express app -> REAL MongoDB (MongoMemoryReplSet).
//
// NOT EXECUTED IN THE AUTHORING SANDBOX (fastdl.mongodb.org -> 403, so
// MongoMemoryReplSet cannot start). Must be run locally.
//
// Nothing here is mocked. The frontend's production modules are imported
// directly (Dexie over fake-indexeddb, real repositories/services, real
// syncQueueLifecycle/Drainer/Executor, real createSyncRequest, real
// apiClient/authManager/authClient doing a REAL /api/auth/login). Requests
// travel over a real socket to createApp() listening on an ephemeral port.

import '../../frontend/node_modules/fake-indexeddb/auto/index.js';
import { test, describe, before, beforeEach, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connectTestDb, clearTestDb, disconnectTestDb } from './helpers/testDb.js';
import { createApp } from '../src/app.js';
import { seedUser } from '../src/scripts/seed.js';
import { Product } from '../src/models/productModel.js';
import { StockEvent } from '../src/models/stockEventModel.js';
import { ProductChangeEvent } from '../src/models/productChangeEventModel.js';
import { Category } from '../src/models/classificationModel.js';

import { createDatabase } from '../../frontend/src/data/db/schema.js';
import { createProductRepository } from '../../frontend/src/data/repositories/productRepository.js';
import { createClassificationRepository } from '../../frontend/src/data/repositories/classificationRepository.js';
import { createStockEventRepository } from '../../frontend/src/data/repositories/stockEventRepository.js';
import { createProductService } from '../../frontend/src/services/productService.js';
import { createStockEventService } from '../../frontend/src/services/stockEventService.js';
import { createSyncQueueLifecycle } from '../../frontend/src/data/sync/syncQueueLifecycle.js';
import { createSyncEntryExecutor } from '../../frontend/src/data/sync/syncEntryExecutor.js';
import { createSyncDrainer } from '../../frontend/src/data/sync/syncDrainer.js';
import { createSessionStore } from '../../frontend/src/auth/sessionStore.js';
import { createAuthClient } from '../../frontend/src/auth/authClient.js';
import { createAuthManager } from '../../frontend/src/auth/authManager.js';
import { createApiClient } from '../../frontend/src/auth/apiClient.js';

const CONFIG = { jwtAccessSecret: 'test-secret', jwtAccessExpiresIn: '15m', refreshTokenExpiresInDays: 90 };
const USER = { username: 'shop', password: 'correct-horse-battery' };

describe('Phase 6G — real frontend sync chain against the real backend', () => {
  let server;
  let baseUrl;
  let db;
  let apiClient;
  let authManager;
  let syncDrainer;
  let productRepository;
  let productService;
  let stockService;
  let classifications;

  before(async () => {
    await connectTestDb();
    server = createApp(CONFIG).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await disconnectTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
    await seedUser(USER);

    db = createDatabase();
    const sessionStore = createSessionStore(db);
    authManager = createAuthManager({ sessionStore, authClient: createAuthClient(baseUrl) });
    apiClient = createApiClient({ authManager, baseUrl });
    await authManager.login(USER.username, USER.password); // real /api/auth/login

    syncDrainer = createSyncDrainer({
      syncQueueLifecycle: createSyncQueueLifecycle(db),
      syncEntryExecutor: createSyncEntryExecutor({ apiClient }),
    });
    classifications = createClassificationRepository(db);
    productRepository = createProductRepository(db);
    productService = createProductService(productRepository, classifications);
    stockService = createStockEventService(createStockEventRepository(db), productRepository);
  });

  afterEach(async () => {
    if (db.isOpen()) db.close();
    await db.delete();
  });

  const drain = async () => {
    const queued = await db.syncQueue.count();
    const result = await syncDrainer.drain();
    return { queued, result };
  };

  test('every entity type syncs to its real endpoint and persists; ADD -> REMOVE -> reversal -> price change converge correctly', async () => {
    await classifications.create('category', { id: 'cat-1', name: 'Snacks', archived: false, isDefault: false });
    await classifications.create('location', { id: 'loc-1', name: 'Shelf A2', archived: false, isDefault: false });
    await classifications.create('tag', { id: 'tag-1', name: 'popular', archived: false, isDefault: false });
    await classifications.create('unit', { id: 'unit-1', name: 'Packet', archived: false, isDefault: false });

    const { product } = await productService.createProduct({ name: 'Parle-G' });
    await stockService.addStock({ productId: product.id, quantity: 10, costPerUnit: 50 });
    const { event: removed } = await stockService.removeStock({ productId: product.id, quantity: 4 });
    const { event: reversal, errors: revErrors } = await stockService.reverseEvent(removed.id);
    assert.deepEqual(revErrors, []);
    const current = await productRepository.getById(product.id);
    const { errors } = await productService.updateProduct(current, { sellingPrice: 12 });
    assert.deepEqual(errors, []);
    const changeRow = (await db.syncQueue.where('entityType').equals('productChangeEvent').toArray())[0];

    const { queued, result } = await drain();

    assert.deepEqual(result, { processed: queued, failed: 0, stopped: false, reason: null });
    assert.equal(await db.syncQueue.count(), 0);

    // Classifications (real Phase 5C endpoints)
    assert.ok(await Category.findById('cat-1').lean());

    // Product: server-authoritative quantity from StockEvents (10 - 4 + 4), LWW price applied
    const remote = await Product.findById(product.id).lean();
    assert.equal(remote.quantity, 10);
    assert.equal(remote.sellingPrice, 12);
    assert.equal(remote.fieldTimestamps.sellingPrice.eventId, changeRow.entityId);

    // StockEvents: 3 persisted; reversedBy derived by the backend, never synced as its own mutation
    assert.equal(await StockEvent.countDocuments({}), 3);
    assert.equal((await StockEvent.findById(removed.id).lean()).reversedBy, reversal.id);
    assert.equal((await StockEvent.findById(reversal.id).lean()).reversalOf, removed.id);
    assert.equal((await StockEvent.findById(removed.id).lean()).appliedQuantity, 4);

    // ProductChangeEvent: stored without `accepted`; computed true because it IS the current LWW winner
    const rawChange = await ProductChangeEvent.collection.findOne({ _id: changeRow.entityId });
    assert.equal(Object.hasOwn(rawChange, 'accepted'), false);
    const listed = await apiClient.request({ method: 'GET', path: `/api/product-change-events?productId=${product.id}` });
    assert.equal(listed.find((e) => e._id === changeRow.entityId).accepted, true);
  });

  test('idempotent redelivery: re-queueing an already-synced StockEvent does not apply it twice', async () => {
    const { product } = await productService.createProduct({ name: 'Milk' });
    const { event } = await stockService.addStock({ productId: product.id, quantity: 5 });
    await drain();
    assert.equal((await Product.findById(product.id).lean()).quantity, 5);

    // Simulate a lost response: the same event row is delivered again.
    const original = await db.syncQueue.filter((r) => r.entityId === event.id).first();
    assert.equal(original, undefined); // it was deleted on success...
    await db.syncQueue.add({
      entityType: 'stockEvent', operation: 'insert', entityId: event.id, clientId: event.id,
      payload: { ...event, appliedQuantity: 5, expectedCurrentQuantity: 0 },
      attempts: 0, status: 'pending', createdAt: new Date().toISOString(), lastError: null,
    });
    const { result } = await drain();

    assert.equal(result.failed, 0); // idempotent no-op, not a 409
    assert.equal(await StockEvent.countDocuments({}), 1);
    assert.equal((await Product.findById(product.id).lean()).quantity, 5);
  });

  test('a permanent rejection (reversal whose original never synced) is marked failed, is not retried, and the drain continues', async () => {
    const { product } = await productService.createProduct({ name: 'Milk' });
    await stockService.addStock({ productId: product.id, quantity: 5 });
    const { event: removed } = await stockService.removeStock({ productId: product.id, quantity: 2 });
    await stockService.reverseEvent(removed.id);
    // Lose the original from the queue only (simulates it having been rejected earlier).
    await db.syncQueue.filter((r) => r.entityId === removed.id).delete();

    const { result } = await drain();

    assert.equal(result.stopped, false);
    assert.ok(result.failed >= 1);
    const failed = await db.syncQueue.where('status').equals('failed').toArray();
    // Which permanent code fires depends on server check ORDER: the
    // expectedCurrentQuantity check (step 3) runs before reversal
    // validation (step 4). Here the server has only the ADD applied, so
    // the reversal's expected quantity is stale and the concurrency check
    // rejects it first (409 QUANTITY_CONSISTENCY_CONFLICT). With a
    // matching quantity it would be 404 NOT_FOUND (see the Phase 6F
    // backend test). Both are permanent under the existing classifier.
    assert.ok(
      failed.some((r) => /QUANTITY_CONSISTENCY_CONFLICT|NOT_FOUND/.test(r.lastError)),
      `unexpected lastError values: ${JSON.stringify(failed.map((r) => r.lastError))}`
    );
    const before = await db.syncQueue.count();
    await drain(); // failed rows are not automatically retried
    assert.equal(await db.syncQueue.count(), before);
  });

  test('a real transient failure (server down) stops the drain and leaves the entry recoverable; a later drain succeeds', async () => {
    await classifications.create('tag', { id: 'tag-x', name: 'x', archived: false, isDefault: false });
    const realFetch = global.fetch;
    global.fetch = async () => { throw new TypeError('fetch failed'); };
    try {
      const { result } = await drain();
      assert.equal(result.stopped, true);
    } finally {
      global.fetch = realFetch;
    }
    assert.equal((await db.syncQueue.toArray())[0].status, 'processing');
    const { result } = await drain(); // recovery -> pending -> delivered
    assert.equal(result.processed, 1);
    assert.equal(await db.syncQueue.count(), 0);
  });

  // Phase 6G locked rule: on an existing Product a tracked field has no
  // client authority without its fieldMutations entry. The client's Product
  // sync entry legitimately carries the full (possibly stale) snapshot;
  // the backend must preserve the newer LWW-protected server value.
  test('a stale device\'s stock-commit Product upsert must not revert a newer LWW-protected sellingPrice', async () => {
    const { product } = await productService.createProduct({ name: 'Milk' });
    await drain();
    // Newer price already on the server (another device, later timestamp).
    await Product.updateOne({ _id: product.id }, { $set: {
      sellingPrice: 65,
      'fieldTimestamps.sellingPrice': { timestamp: new Date('2099-01-01T00:00:00.000Z'), eventId: 'evt-newer' },
    } });
    // This device (stale price = null) records a stock ADD -> Product upsert with no fieldMutations.
    await stockService.addStock({ productId: product.id, quantity: 3 });
    // The stale snapshot is genuinely on the wire: it carries the tracked
    // fields, and NO fieldMutations for sellingPrice.
    const productEntry = (await db.syncQueue.where('entityType').equals('product').toArray()).pop();
    assert.equal(Object.hasOwn(productEntry.payload, 'sellingPrice'), true);
    assert.equal(productEntry.payload.sellingPrice ?? null, null);
    // A stock-commit Product entry carries no fieldMutations at all.
    assert.equal(Object.hasOwn(productEntry.payload.fieldMutations ?? {}, 'sellingPrice'), false);

    const { result } = await drain();
    assert.equal(result.failed, 0); // the backend ACCEPTS the upsert...

    const remote = await Product.findById(product.id).lean();
    assert.equal(remote.sellingPrice, 65); // ...but the newer server value is preserved
    assert.equal(remote.fieldTimestamps.sellingPrice.eventId, 'evt-newer');
    assert.equal(remote.quantity, 3);
  });
});
